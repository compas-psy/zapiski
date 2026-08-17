//! Единственный модуль, который знает про JNI.
//!
//! Всё, до чего из webview не дотянуться, — FLAG_SECURE, вибрация,
//! BiometricPrompt, системная печать, скачивание и установка обновления,
//! перерисовка виджетов — делает Kotlin (`apps/mobile/android/.../*.kt`), а
//! этот модуль вызывает его и принимает ответы.
//!
//! Два направления:
//!
//! * Rust → Java: статические методы класса `ru.cmpas.zapiski.NativeBridge`.
//! * Java → Rust: функции `Java_ru_cmpas_zapiski_NativeBridge_native*` ниже.
//!   Java зовёт их из своих потоков, поэтому общее состояние — под мьютексом,
//!   а результат уезжает по каналу тому, кто его ждёт.
//!
//! Асинхронные операции Android (биометрия, печать, загрузка) устроены
//! одинаково: Rust заводит `request_id`, зовёт Java и блокируется на канале;
//! Java, закончив, отдаёт результат в `nativeResult` с тем же `request_id`.
//! Команды Tauri помечены `async`, то есть исполняются на рабочем потоке, —
//! главный поток при этом свободен.
//!
//! На не-Android целях (в этом окружении компиляция проверяется под linux)
//! каждая функция возвращает `Err("… доступно только на Android")`. Это
//! осознанно: заглушка, которая делает вид, что сработала, обманула бы и
//! тесты, и человека.

// Очередь запросов нужна только Android-ветке; под linux она собирается, но
// не используется — это ожидаемо и не повод глушить предупреждения в других
// местах файла.
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Биометрия и печать ждут человека и движок печати — минуты, не секунды.
const SLOW: Duration = Duration::from_secs(180);
/// Загрузка APK: 30 МБ по мобильной сети бывают долгими.
const DOWNLOAD: Duration = Duration::from_secs(1800);

/// Результат асинхронной операции Java-стороны.
pub struct Outcome {
    /// Операция завершилась без ошибки. Отмена пользователем — это `ok: true`
    /// и пустые данные: BEHAVIOR §5.2 прямо говорит, что отмена биометрии не
    /// ошибка и сообщений показывать не нужно.
    pub ok: bool,
    pub text: Option<String>,
    pub data: Option<Vec<u8>>,
}

impl Outcome {
    /// Свести результат к тому, чего ждут команды.
    pub fn into_result(self) -> Result<Option<Vec<u8>>, String> {
        if self.ok {
            Ok(self.data)
        } else {
            Err(self
                .text
                .unwrap_or_else(|| "не удалось выполнить операцию".to_owned()))
        }
    }
}

static PENDING: OnceLock<Mutex<HashMap<i64, Sender<Outcome>>>> = OnceLock::new();
static NEXT_REQUEST: AtomicI64 = AtomicI64::new(1);

fn pending() -> &'static Mutex<HashMap<i64, Sender<Outcome>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Завести идентификатор запроса и канал, по которому придёт ответ.
fn register() -> (i64, Receiver<Outcome>) {
    let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = channel();
    if let Ok(mut map) = pending().lock() {
        map.insert(id, tx);
    }
    (id, rx)
}

fn forget(id: i64) {
    if let Ok(mut map) = pending().lock() {
        map.remove(&id);
    }
}

/// Дождаться ответа Java. Таймаут не «на всякий случай»: если активность
/// умерла вместе с Java-стороной, команда обязана вернуть ошибку, а не висеть
/// вечно, удерживая поток рантайма.
fn wait(id: i64, rx: Receiver<Outcome>, timeout: Duration) -> Result<Outcome, String> {
    let result = match rx.recv_timeout(timeout) {
        Ok(outcome) => Ok(outcome),
        Err(RecvTimeoutError::Timeout) => {
            Err("операция не завершилась за отведённое время".to_owned())
        }
        Err(RecvTimeoutError::Disconnected) => Err("операция прервана".to_owned()),
    };
    forget(id);
    result
}

/// Отдать результат тому, кто его ждёт. Никого нет — значит, запрос уже
/// отвалился по таймауту; это не ошибка.
fn complete(id: i64, outcome: Outcome) {
    let sender = pending().lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(outcome);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Android: настоящий мост
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "android")]
mod api {
    use super::{complete, forget, register, wait, Outcome, DOWNLOAD, SLOW};
    use crate::{platform, widgets};

    use jni::objects::{GlobalRef, JByteArray, JObject, JString, JValue, JValueOwned};
    use jni::sys::{jboolean, jlong};
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    /// Класс со всеми статическими методами Java-стороны.
    const BRIDGE: &str = "ru/cmpas/zapiski/NativeBridge";

    /// Класс моста, найденный ЗАГРУЗЧИКОМ ПРИЛОЖЕНИЯ и сохранённый навсегда.
    ///
    /// Без него оболочка носила скрытую мину. `FindClass` ищет класс тем
    /// загрузчиком, который принадлежит текущему потоку, а поток, прикреплённый
    /// к виртуальной машине из нативного кода (`AttachCurrentThread`), получает
    /// СИСТЕМНЫЙ загрузчик — тот не знает ни одного класса приложения. Команды
    /// Tauri выполняются в пуле, и попадание в такой поток — вопрос удачи.
    ///
    /// Заказчик вытащил мину наружу кнопкой «Поделиться»:
    /// `ClassNotFoundException: Didn't find class "ru.cmpas.zapiski.NativeBridge"`.
    /// Ровно это могло случиться с любым другим вызовом — папкой, биометрией,
    /// виджетами, — просто там раньше везло.
    ///
    /// Ссылку берём в `nativeInit`: его зовёт САМА Java, и загрузчик там
    /// правильный. Глобальная ссылка живёт вечно и работает в любом потоке.
    static BRIDGE_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    /// Статический метод моста. Класс — из кеша, пока он есть.
    fn call_bridge<'local>(
        env: &mut JNIEnv<'local>,
        method: &str,
        signature: &str,
        args: &[JValue],
    ) -> Result<JValueOwned<'local>, jni::errors::Error> {
        match BRIDGE_CLASS.get() {
            Some(class) => env.call_static_method(class, method, signature, args),
            /* Кеша нет — значит `nativeInit` ещё не отработал. Ищем по имени:
            в потоке, пришедшем из Java, это сработает. */
            None => env.call_static_method(BRIDGE, method, signature, args),
        }
    }

    /// Виртуальная машина. Её отдаёт первый вызов из Java — `nativeInit`,
    /// который `MainActivity` делает в `onCreate`, уже после загрузки
    /// нативной библиотеки.
    static VM: OnceLock<JavaVM> = OnceLock::new();

    /// Выполнить действие в контексте JNI, привязав текущий поток к ВМ.
    fn with_env<T>(
        action: impl FnOnce(&mut JNIEnv) -> Result<T, jni::errors::Error>,
    ) -> Result<T, String> {
        let machine = VM
            .get()
            .ok_or_else(|| "Java-мост ещё не инициализирован".to_owned())?;
        let mut guard = machine
            .attach_current_thread()
            .map_err(|error| format!("не удалось подключить поток к JVM: {error}"))?;

        let result = action(&mut guard);

        // Исключение, оставленное в потоке, «прилипнет» к следующему вызову и
        // уронит его в непонятном месте, поэтому разбираем его здесь же.
        //
        // И разбираем ПО-НАСТОЯЩЕМУ: раньше здесь стояло общее «Java-сторона
        // завершилась исключением», а текст уходил в logcat, до которого у
        // человека с телефоном доступа нет. Заказчик получил ровно эту фразу
        // на кнопке «Поделиться» — и починить по ней было нечего. Теперь класс
        // и сообщение исключения поднимаются наверх и показываются словами.
        if guard.exception_check().unwrap_or(false) {
            let described = exception_text(&mut guard);
            return Err(
                described.unwrap_or_else(|| "Java-сторона завершилась исключением".to_owned())
            );
        }
        result.map_err(|error| format!("вызов Java не удался: {error}"))
    }

    /// Текст висящего исключения: `java.lang.IllegalStateException: …`.
    ///
    /// Снимаем исключение ДО любых других вызовов JNI — с висящим исключением
    /// вызывать `toString()` нельзя, и попытка кончилась бы вторым, уже
    /// непонятным отказом.
    fn exception_text(env: &mut JNIEnv) -> Option<String> {
        let throwable = env.exception_occurred().ok()?;
        env.exception_clear().ok()?;
        let value = env
            .call_method(&throwable, "toString", "()Ljava/lang/String;", &[])
            .ok()?
            .l()
            .ok()?;
        let text: String = env.get_string(&JString::from(value)).ok()?.into();
        Some(text)
    }

    pub fn set_secure(on: bool) -> Result<(), String> {
        with_env(|env| {
            call_bridge(env, "setSecure", "(Z)V", &[JValue::Bool(u8::from(on))])?;
            Ok(())
        })
    }

    pub fn haptic(strength: i32) -> Result<(), String> {
        with_env(|env| {
            call_bridge(env, "haptic", "(I)V", &[JValue::Int(strength)])?;
            Ok(())
        })
    }

    /// Строковый результат метода без аргументов. `None` — Java вернула `null`.
    fn string_getter(method: &str) -> Result<Option<String>, String> {
        with_env(|env| {
            let value = call_bridge(env, method, "()Ljava/lang/String;", &[])?.l()?;
            if value.is_null() {
                return Ok(None);
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(Some(text))
        })
    }

    pub fn external_files_dir() -> Result<Option<String>, String> {
        string_getter("externalFilesDir")
    }

    pub fn files_dir() -> Result<Option<String>, String> {
        string_getter("filesDir")
    }

    pub fn cache_dir() -> Result<Option<String>, String> {
        string_getter("cacheDir")
    }

    pub fn biometrics_available() -> Result<bool, String> {
        with_env(|env| call_bridge(env, "biometricsAvailable", "()Z", &[])?.z())
    }

    pub fn biometrics_enroll(key_id: &str, secret: &[u8]) -> Result<(), String> {
        let (id, rx) = register();
        let started = with_env(|env| {
            let key = env.new_string(key_id)?;
            let data = env.byte_array_from_slice(secret)?;
            env.call_static_method(
                BRIDGE,
                "biometricsEnroll",
                "(JLjava/lang/String;[B)V",
                &[
                    JValue::Long(id),
                    JValue::Object(&key),
                    JValue::Object(&data),
                ],
            )?;
            Ok(())
        });
        if let Err(error) = started {
            forget(id);
            return Err(error);
        }
        wait(id, rx, SLOW)?.into_result().map(|_| ())
    }

    pub fn biometrics_unlock(key_id: &str) -> Result<Option<Vec<u8>>, String> {
        let (id, rx) = register();
        let started = with_env(|env| {
            let key = env.new_string(key_id)?;
            env.call_static_method(
                BRIDGE,
                "biometricsUnlock",
                "(JLjava/lang/String;)V",
                &[JValue::Long(id), JValue::Object(&key)],
            )?;
            Ok(())
        });
        if let Err(error) = started {
            forget(id);
            return Err(error);
        }
        wait(id, rx, SLOW)?.into_result()
    }

    pub fn biometrics_remove(key_id: &str) -> Result<(), String> {
        with_env(|env| {
            let key = env.new_string(key_id)?;
            env.call_static_method(
                BRIDGE,
                "biometricsRemove",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&key)],
            )?;
            Ok(())
        })
    }

    pub fn render_pdf(html: &str, margin_mm: f64) -> Result<Vec<u8>, String> {
        let (id, rx) = register();
        let started = with_env(|env| {
            let source = env.new_string(html)?;
            env.call_static_method(
                BRIDGE,
                "renderPdf",
                "(JLjava/lang/String;D)V",
                &[
                    JValue::Long(id),
                    JValue::Object(&source),
                    JValue::Double(margin_mm),
                ],
            )?;
            Ok(())
        });
        if let Err(error) = started {
            forget(id);
            return Err(error);
        }
        wait(id, rx, SLOW)?
            .into_result()?
            .ok_or_else(|| "движок печати не вернул документ".to_owned())
    }

    /// Синхронный GET силами платформы. Вызывается только из
    /// `#[tauri::command(async)]`, то есть с рабочего потока: сеть на главном
    /// потоке Android запрещена самой ОС.
    pub fn http_get(url: &str) -> Result<String, String> {
        with_env(|env| {
            let target = env.new_string(url)?;
            let value = call_bridge(
                env,
                "httpGet",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&target)],
            )?
            .l()?;
            if value.is_null() {
                return Ok(String::new());
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(text)
        })
    }

    pub fn download(url: &str, destination: &str) -> Result<(), String> {
        let (id, rx) = register();
        let started = with_env(|env| {
            let source = env.new_string(url)?;
            let target = env.new_string(destination)?;
            env.call_static_method(
                BRIDGE,
                "download",
                "(JLjava/lang/String;Ljava/lang/String;)V",
                &[
                    JValue::Long(id),
                    JValue::Object(&source),
                    JValue::Object(&target),
                ],
            )?;
            Ok(())
        });
        if let Err(error) = started {
            forget(id);
            return Err(error);
        }
        wait(id, rx, DOWNLOAD)?.into_result().map(|_| ())
    }

    pub fn install_apk(path: &str) -> Result<(), String> {
        with_env(|env| {
            let target = env.new_string(path)?;
            env.call_static_method(
                BRIDGE,
                "installApk",
                "(Ljava/lang/String;)V",
                &[JValue::Object(&target)],
            )?;
            Ok(())
        })
    }

    pub fn refresh_widgets() -> Result<(), String> {
        with_env(|env| {
            call_bridge(env, "refreshWidgets", "()V", &[])?;
            Ok(())
        })
    }

    // ── Папка пользователя через SAF (ТЗ §4.1 п. 1) ─────────────────────────
    //
    // Строковый результат этих методов — либо полезное значение, либо `null`
    // как «нет такого». Отказ отличается от «нет такого» исключением на
    // Java-стороне: `with_env` превращает его в ошибку команды.

    /// Системный выбор папки. `None` — пользователь отменил.
    pub fn saf_pick_folder() -> Result<Option<String>, String> {
        let (id, rx) = register();
        let started = with_env(|env| {
            call_bridge(env, "safPickFolder", "(J)V", &[JValue::Long(id)])?;
            Ok(())
        });
        if let Err(error) = started {
            forget(id);
            return Err(error);
        }
        // Человек у диалога выбора думает столько же, сколько у биометрии.
        let outcome = wait(id, rx, SLOW)?;
        if !outcome.ok {
            return Err(outcome
                .text
                .unwrap_or_else(|| "не удалось открыть выбор папки".to_owned()));
        }
        Ok(outcome.text.filter(|value| !value.is_empty()))
    }

    /// Строковый метод с одним строковым аргументом.
    fn saf_string(method: &str, tree: &str) -> Result<Option<String>, String> {
        with_env(|env| {
            let argument = env.new_string(tree)?;
            let value = call_bridge(
                env,
                method,
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&argument)],
            )?
            .l()?;
            if value.is_null() {
                return Ok(None);
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(Some(text))
        })
    }

    fn saf_bool(method: &str, tree: &str) -> Result<bool, String> {
        with_env(|env| {
            let argument = env.new_string(tree)?;
            call_bridge(
                env,
                method,
                "(Ljava/lang/String;)Z",
                &[JValue::Object(&argument)],
            )?
            .z()
        })
    }

    pub fn saf_label(tree: &str) -> Result<Option<String>, String> {
        saf_string("safLabel", tree)
    }

    pub fn saf_supports_rename(tree: &str) -> Result<bool, String> {
        saf_bool("safSupportsRename", tree)
    }

    pub fn saf_has_access(tree: &str) -> Result<bool, String> {
        saf_bool("safHasAccess", tree)
    }

    /// Деревья, разрешение на которые есть прямо сейчас (JSON, новейшее первым).
    pub fn saf_persisted_trees() -> Result<String, String> {
        Ok(string_getter("safPersistedTrees")?.unwrap_or_else(|| "[]".to_owned()))
    }

    /// Отпустить разрешения на все деревья — возврат в каталог приложения.
    pub fn saf_release_trees() -> Result<(), String> {
        with_env(|env| {
            call_bridge(env, "safReleaseTrees", "()V", &[])?;
            Ok(())
        })
    }

    /// Метод «дерево + путь → строка». `None` — такого документа нет.
    fn saf_path_string(method: &str, tree: &str, path: &str) -> Result<Option<String>, String> {
        with_env(|env| {
            let tree = env.new_string(tree)?;
            let path = env.new_string(path)?;
            let value = call_bridge(
                env,
                method,
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&tree), JValue::Object(&path)],
            )?
            .l()?;
            if value.is_null() {
                return Ok(None);
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(Some(text))
        })
    }

    pub fn saf_list(tree: &str, path: &str) -> Result<String, String> {
        saf_path_string("safList", tree, path)?.ok_or_else(|| format!("каталога нет: {path}"))
    }

    pub fn saf_stat(tree: &str, path: &str) -> Result<Option<String>, String> {
        saf_path_string("safStat", tree, path)
    }

    pub fn saf_read(tree: &str, path: &str) -> Result<Vec<u8>, String> {
        with_env(|env| {
            let tree = env.new_string(tree)?;
            let path = env.new_string(path)?;
            let value = call_bridge(
                env,
                "safRead",
                "(Ljava/lang/String;Ljava/lang/String;)[B",
                &[JValue::Object(&tree), JValue::Object(&path)],
            )?
            .l()?;
            if value.is_null() {
                return Ok(None);
            }
            let array = JByteArray::from(value);
            Ok(Some(env.convert_byte_array(&array)?))
        })?
        .ok_or_else(|| format!("файла нет: {path}"))
    }

    /// Запись. Java возвращает фактический режим: `staged` либо `direct`.
    pub fn saf_write(tree: &str, path: &str, data: &[u8]) -> Result<String, String> {
        with_env(|env| {
            let tree = env.new_string(tree)?;
            let path = env.new_string(path)?;
            let bytes = env.byte_array_from_slice(data)?;
            let value = call_bridge(
                env,
                "safWrite",
                "(Ljava/lang/String;Ljava/lang/String;[B)Ljava/lang/String;",
                &[
                    JValue::Object(&tree),
                    JValue::Object(&path),
                    JValue::Object(&bytes),
                ],
            )?
            .l()?;
            if value.is_null() {
                return Ok(String::new());
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(text)
        })
    }

    /// Действие без результата: неудача приходит исключением Java-стороны.
    fn saf_action(
        method: &str,
        tree: &str,
        first: &str,
        second: Option<&str>,
    ) -> Result<(), String> {
        with_env(|env| {
            let tree = env.new_string(tree)?;
            let first = env.new_string(first)?;
            match second {
                None => {
                    env.call_static_method(
                        BRIDGE,
                        method,
                        "(Ljava/lang/String;Ljava/lang/String;)V",
                        &[JValue::Object(&tree), JValue::Object(&first)],
                    )?;
                }
                Some(second) => {
                    let second = env.new_string(second)?;
                    env.call_static_method(
                        BRIDGE,
                        method,
                        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                        &[
                            JValue::Object(&tree),
                            JValue::Object(&first),
                            JValue::Object(&second),
                        ],
                    )?;
                }
            }
            Ok(())
        })
    }

    pub fn saf_mkdir(tree: &str, path: &str) -> Result<(), String> {
        saf_action("safMkdir", tree, path, None)
    }

    pub fn saf_remove(tree: &str, path: &str) -> Result<(), String> {
        saf_action("safRemove", tree, path, None)
    }

    /// Открыть вложение системным приложением. `false` — открывать нечем.
    pub fn saf_open(tree: &str, path: &str) -> Result<bool, String> {
        with_env(|env| {
            let tree = env.new_string(tree)?;
            let path = env.new_string(path)?;
            let value = call_bridge(
                env,
                "safOpen",
                "(Ljava/lang/String;Ljava/lang/String;)Z",
                &[JValue::Object(&tree), JValue::Object(&path)],
            )?
            .z()?;
            Ok(value)
        })
    }

    pub fn saf_rename(tree: &str, from: &str, to: &str) -> Result<(), String> {
        saf_action("safRename", tree, from, Some(to))
    }

    /// Отдать текст системному «Поделиться».
    ///
    /// Возвращает то, что ответила Java: `shared`, `copied` либо строку с
    /// ошибкой. Булев ответ здесь был ошибкой: любая беда превращалась в
    /// `false`, а приложение объявляло её «принять некому» — и человек искал
    /// причину не там.
    pub fn share_text(title: &str, body: &str) -> Result<String, String> {
        with_env(|env| {
            let title = env.new_string(title)?;
            let body = env.new_string(body)?;
            let value = call_bridge(
                env,
                "shareText",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&title), JValue::Object(&body)],
            )?
            .l()?;
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(text)
        })
    }

    /// Положить готовый файл туда, где пользователь его найдёт. Java
    /// возвращает `null` при успехе и текст ошибки иначе.
    pub fn save_to_downloads(name: &str, mime: &str, source: &str) -> Result<(), String> {
        let failure = with_env(|env| {
            let name = env.new_string(name)?;
            let mime = env.new_string(mime)?;
            let source = env.new_string(source)?;
            let value = call_bridge(
                env,
                "saveToDownloads",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[
                    JValue::Object(&name),
                    JValue::Object(&mime),
                    JValue::Object(&source),
                ],
            )?
            .l()?;
            if value.is_null() {
                return Ok(None);
            }
            let text: String = env.get_string(&JString::from(value))?.into();
            Ok(Some(text))
        })?;

        match failure {
            None => Ok(()),
            Some(message) => Err(message),
        }
    }

    // ── Функции, которые зовёт Java ─────────────────────────────────────────

    /// Первый вызов из `MainActivity.onCreate`: запоминаем виртуальную машину.
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeInit(
        mut env: JNIEnv,
        _this: JObject,
    ) {
        /*
         * Порядок здесь — не вкусовщина, он и есть починка.
         *
         * Класс кешируется ПЕРВЫМ, виртуальная машина — вторым, потому что
         * `VM` служит пропуском: `with_env` без неё не начинает работу вовсе.
         * Пока `VM` ставилась первой, между двумя строками оставалась щель, и
         * команда Tauri, попавшая в неё, проходила пропускной пункт с ещё
         * пустым кешем — а дальше искала класс `FindClass`-ем в потоке пула,
         * где загрузчик системный. Отсюда `ClassNotFoundException:
         * ru.cmpas.zapiski.NativeBridge`, приходивший через раз и всегда на
         * первых секундах после запуска: именно там эти две вещи и совпадают
         * по времени.
         *
         * `OnceLock` даёт нужные гарантии видимости: поток, увидевший `VM`,
         * увидит и всё, что записано до неё.
         *
         * Загрузчик классов правильный только здесь — вызов пришёл из Java
         * (см. BRIDGE_CLASS).
         */
        if let Ok(class) = env.find_class(BRIDGE) {
            if let Ok(global) = env.new_global_ref(class) {
                let _ = BRIDGE_CLASS.set(global);
            }
        }
        /* Исключение от неудачного поиска нельзя оставлять висеть: следующий
        же вызов JNI в этом потоке упадёт на нём, и упадёт не там, где
        сломалось. */
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        if let Ok(machine) = env.get_java_vm() {
            let _ = VM.set(machine);
        }
    }

    /// Ответ на асинхронную операцию: биометрия, печать, загрузка.
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeResult(
        mut env: JNIEnv,
        _this: JObject,
        request_id: jlong,
        ok: jboolean,
        text: JString,
        data: JByteArray,
    ) {
        let text = if text.is_null() {
            None
        } else {
            env.get_string(&text).ok().map(String::from)
        };
        let data = if data.is_null() {
            None
        } else {
            env.convert_byte_array(&data).ok()
        };
        complete(
            request_id,
            Outcome {
                ok: ok != 0,
                text,
                data,
            },
        );
    }

    /// Прогресс скачивания обновления. `total <= 0` — сервер не сообщил длину.
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeProgress(
        _env: JNIEnv,
        _this: JObject,
        _request_id: jlong,
        done: jlong,
        total: jlong,
    ) {
        let fraction = if total > 0 {
            (done as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
        platform::emit_update_progress(fraction);
    }

    /// В очереди share-target что-то появилось (BEHAVIOR §8). Полезной
    /// нагрузки нет намеренно: контент уже лежит в файле очереди, и забрать
    /// его оттуда — единственный способ не отдать одну картинку дважды.
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeShare(
        _env: JNIEnv,
        _this: JObject,
    ) {
        platform::poke_share();
    }

    /// Плитка Quick Settings или виджет «Записать».
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeQuickNote(
        _env: JNIEnv,
        _this: JObject,
    ) {
        platform::emit_quick_note();
    }

    /// В очереди виджетов что-то появилось — тап по чекбоксу в «Закреплённой».
    /// Полезной нагрузки нет намеренно: команда уже лежит в файле очереди,
    /// и забрать её оттуда — единственный способ не выдать одну отметку дважды.
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeWidgetCommand(
        _env: JNIEnv,
        _this: JObject,
    ) {
        widgets::poke();
    }

    /// Возврат после входа: `zapiski://…` или App Link на `zapiski.cmpas.ru`.
    /// Адрес не передаётся аргументом и не попадает в журнал — во фрагменте
    /// едет токен сессии. Он уже лежит в файле очереди, откуда его заберут
    /// ровно один раз.
    #[no_mangle]
    pub extern "system" fn Java_ru_cmpas_zapiski_NativeBridge_nativeAuthCallback(
        _env: JNIEnv,
        _this: JObject,
    ) {
        platform::poke_auth();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Не-Android: честные заглушки
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
mod api {
    //! Существуют ровно затем, чтобы крейт компилировался и проверялся на
    //! машине разработчика, где Android SDK нет. Ни одна из них не делает
    //! вид, что операция удалась.

    fn only_android<T>(what: &str) -> Result<T, String> {
        Err(format!("{what} доступно только на Android"))
    }

    pub fn set_secure(_on: bool) -> Result<(), String> {
        only_android("FLAG_SECURE")
    }
    pub fn haptic(_strength: i32) -> Result<(), String> {
        only_android("хэптика")
    }
    pub fn external_files_dir() -> Result<Option<String>, String> {
        only_android("внешний каталог приложения")
    }
    pub fn files_dir() -> Result<Option<String>, String> {
        only_android("каталог приложения")
    }
    pub fn cache_dir() -> Result<Option<String>, String> {
        only_android("кэш приложения")
    }
    /// Не ошибка, а честный ответ: биометрии здесь нет — UI скроет тумблер.
    pub fn biometrics_available() -> Result<bool, String> {
        Ok(false)
    }
    pub fn biometrics_enroll(_key_id: &str, _secret: &[u8]) -> Result<(), String> {
        only_android("биометрия")
    }
    pub fn biometrics_unlock(_key_id: &str) -> Result<Option<Vec<u8>>, String> {
        only_android("биометрия")
    }
    pub fn biometrics_remove(_key_id: &str) -> Result<(), String> {
        only_android("биометрия")
    }
    pub fn render_pdf(_html: &str, _margin_mm: f64) -> Result<Vec<u8>, String> {
        only_android("печать в PDF")
    }
    pub fn http_get(_url: &str) -> Result<String, String> {
        only_android("сетевой запрос через платформу")
    }
    pub fn download(_url: &str, _destination: &str) -> Result<(), String> {
        only_android("скачивание обновления")
    }
    pub fn install_apk(_path: &str) -> Result<(), String> {
        only_android("установка пакета")
    }
    pub fn refresh_widgets() -> Result<(), String> {
        only_android("виджеты")
    }
    pub fn save_to_downloads(_name: &str, _mime: &str, _source: &str) -> Result<(), String> {
        only_android("сохранение файла")
    }

    // ── SAF ─────────────────────────────────────────────────────────────────
    //
    // `saf_pick_folder` отвечает «выбора нет» (`Ok(None)`), а не ошибкой:
    // ровно так же выглядит отмена пользователем, и вызывающий на обеих
    // платформах поступает одинаково — остаётся в каталоге приложения.

    pub fn saf_pick_folder() -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn saf_label(_tree: &str) -> Result<Option<String>, String> {
        only_android("папка через SAF")
    }
    pub fn saf_supports_rename(_tree: &str) -> Result<bool, String> {
        only_android("папка через SAF")
    }
    /// Доступа к чужой папке здесь нет и быть не может — но это не отказ.
    pub fn saf_has_access(_tree: &str) -> Result<bool, String> {
        Ok(false)
    }
    /// Разрешений нет — и это тоже ответ, а не отказ: список просто пуст.
    pub fn saf_persisted_trees() -> Result<String, String> {
        Ok("[]".to_owned())
    }
    /// Отпускать нечего — тишина здесь честнее ошибки.
    pub fn saf_release_trees() -> Result<(), String> {
        Ok(())
    }
    pub fn saf_list(_tree: &str, _path: &str) -> Result<String, String> {
        only_android("папка через SAF")
    }
    pub fn saf_stat(_tree: &str, _path: &str) -> Result<Option<String>, String> {
        only_android("папка через SAF")
    }
    pub fn saf_read(_tree: &str, _path: &str) -> Result<Vec<u8>, String> {
        only_android("папка через SAF")
    }
    pub fn saf_write(_tree: &str, _path: &str, _data: &[u8]) -> Result<String, String> {
        only_android("папка через SAF")
    }
    pub fn saf_mkdir(_tree: &str, _path: &str) -> Result<(), String> {
        only_android("папка через SAF")
    }
    pub fn saf_open(_tree: &str, _path: &str) -> Result<bool, String> {
        Ok(false)
    }
    pub fn saf_remove(_tree: &str, _path: &str) -> Result<(), String> {
        only_android("папка через SAF")
    }
    pub fn saf_rename(_tree: &str, _from: &str, _to: &str) -> Result<(), String> {
        only_android("папка через SAF")
    }
    pub fn share_text(_title: &str, _body: &str) -> Result<String, String> {
        Ok(String::from(
            "error: системного «Поделиться» нет на этой платформе",
        ))
    }
}

pub use api::{
    biometrics_available, biometrics_enroll, biometrics_remove, biometrics_unlock, cache_dir,
    download, external_files_dir, files_dir, haptic, http_get, install_apk, refresh_widgets,
    render_pdf, saf_has_access, saf_label, saf_list, saf_mkdir, saf_open, saf_persisted_trees,
    saf_pick_folder, saf_read, saf_release_trees, saf_remove, saf_rename, saf_stat,
    saf_supports_rename, saf_write, save_to_downloads, set_secure, share_text,
};
