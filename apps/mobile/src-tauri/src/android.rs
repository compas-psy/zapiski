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

    use jni::objects::{JByteArray, JObject, JString, JValue};
    use jni::sys::{jboolean, jlong};
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;

    /// Класс со всеми статическими методами Java-стороны.
    const BRIDGE: &str = "ru/cmpas/zapiski/NativeBridge";

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
        if guard.exception_check().unwrap_or(false) {
            let _ = guard.exception_describe();
            let _ = guard.exception_clear();
            return Err("Java-сторона завершилась исключением".to_owned());
        }
        result.map_err(|error| format!("вызов Java не удался: {error}"))
    }

    pub fn set_secure(on: bool) -> Result<(), String> {
        with_env(|env| {
            env.call_static_method(BRIDGE, "setSecure", "(Z)V", &[JValue::Bool(u8::from(on))])?;
            Ok(())
        })
    }

    pub fn haptic(strength: i32) -> Result<(), String> {
        with_env(|env| {
            env.call_static_method(BRIDGE, "haptic", "(I)V", &[JValue::Int(strength)])?;
            Ok(())
        })
    }

    /// Строковый результат метода без аргументов. `None` — Java вернула `null`.
    fn string_getter(method: &str) -> Result<Option<String>, String> {
        with_env(|env| {
            let value = env
                .call_static_method(BRIDGE, method, "()Ljava/lang/String;", &[])?
                .l()?;
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
        with_env(|env| {
            env.call_static_method(BRIDGE, "biometricsAvailable", "()Z", &[])?
                .z()
        })
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
                &[JValue::Long(id), JValue::Object(&key), JValue::Object(&data)],
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
            let value = env
                .call_static_method(
                    BRIDGE,
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
            env.call_static_method(BRIDGE, "refreshWidgets", "()V", &[])?;
            Ok(())
        })
    }

    /// Положить готовый файл туда, где пользователь его найдёт. Java
    /// возвращает `null` при успехе и текст ошибки иначе.
    pub fn save_to_downloads(name: &str, mime: &str, source: &str) -> Result<(), String> {
        let failure = with_env(|env| {
            let name = env.new_string(name)?;
            let mime = env.new_string(mime)?;
            let source = env.new_string(source)?;
            let value = env
                .call_static_method(
                    BRIDGE,
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
        env: JNIEnv,
        _this: JObject,
    ) {
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
}

pub use api::{
    biometrics_available, biometrics_enroll, biometrics_remove, biometrics_unlock, cache_dir,
    download, external_files_dir, files_dir, haptic, http_get, install_apk, refresh_widgets,
    render_pdf, save_to_downloads, set_secure,
};
