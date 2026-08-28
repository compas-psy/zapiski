//! Оконные и процессные мелочи, которые нельзя сделать из webview.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

/// Метка главного окна. Второго окна у оболочки нет: «быстрая заметка» — это
/// не отдельный экран, а событие для `packages/app` (ARCHITECTURE §1).
pub const MAIN_WINDOW: &str = "main";

/// Аргумент, с которым приложение стартует из автозапуска: окно не
/// показывается, живёт только иконка в трее (ТЗ §5.4 «автозапуск в трей»).
pub const TRAY_ARG: &str = "--tray";

/// Глобальный хоткей сработал. Полезная нагрузка — акселератор, чтобы
/// фронтенд знал, чей это обработчик.
pub const EVENT_HOTKEY: &str = "zapiski://global-hotkey";

/// Пункт трея «Быстрая заметка».
pub const EVENT_QUICK_NOTE: &str = "zapiski://quick-note";

/// ОС попросила открыть `.md` (ассоциация файлов, ТЗ §5.4).
pub const EVENT_OPEN_FILE: &str = "zapiski://open-file";

/// Сколько ждём сигнала от фронтенда, прежде чем показать окно самим.
///
/// Бюджет холодного старта — 2 с (ТЗ §6), так что в норме сигнал приходит
/// заметно раньше. Запас нужен на другой случай: если бандл не загрузился
/// или упал на старте, приложение обязано показать окно, а не остаться
/// невидимым процессом в диспетчере задач.
const REVEAL_FALLBACK: Duration = Duration::from_millis(2_500);

/// Кто уже показал главное окно и можно ли его показывать вообще.
///
/// Окно объявлено скрытым (`tauri.conf.json` → `visible: false`) и
/// показывается только после того, как фронтенд смонтировался: тогда первый
/// же кадр нарисован в выбранной пользователем теме — без белой вспышки и без
/// прыжка окна из центра экрана в сохранённое место.
#[derive(Default)]
pub struct WindowGate {
    revealed: AtomicBool,
    /// Запуск из автозагрузки: окна быть не должно, живёт только трей.
    suppressed: AtomicBool,
}

impl WindowGate {
    pub fn suppress(&self) {
        self.suppressed.store(true, Ordering::SeqCst);
    }
}

pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

/// Фронтенд смонтировался и готов показаться.
#[tauri::command]
pub fn shell_ready<R: Runtime>(app: AppHandle<R>) {
    reveal_main_window(&app);
}

/// Показать главное окно первый раз — если запуск не был «в трей».
fn reveal_main_window<R: Runtime>(app: &AppHandle<R>) {
    let gate = app.state::<WindowGate>();
    if gate.suppressed.load(Ordering::SeqCst) {
        return;
    }
    if gate.revealed.swap(true, Ordering::SeqCst) {
        return;
    }
    show_main_window(app);
}

/// Подстраховка на случай, если фронтенд не подал сигнала.
pub fn arm_reveal_fallback<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FALLBACK);
        reveal_main_window(&app);
    });
}

/// Показать и сфокусировать главное окно. Вызывается из трея, из второго
/// экземпляра приложения и при срабатывании глобального хоткея.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = main_window(app) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Быстрая заметка: окно наверх и событие фронтенду. Что именно показать —
/// решает `packages/app`; оболочка не рисует ни одного экрана.
pub fn quick_note<R: Runtime>(app: &AppHandle<R>) {
    show_main_window(app);
    let _ = app.emit(EVENT_QUICK_NOTE, ());
}

/// Разобрать аргументы командной строки и, если среди них есть путь к файлу,
/// сообщить об этом фронтенду.
///
/// ⚠️ Порт для этого в `AppHost` пока не объявлен: приложение событие
/// получает, но обработать его контрактом не может. Оболочка делает свою
/// половину — регистрирует ассоциацию и доставляет путь; вторая половина —
/// поле в `AppHost` (ARCHITECTURE §1: «не хватает порта — добавляется порт,
/// а не экран»).
pub fn forward_file_arguments<R: Runtime>(app: &AppHandle<R>, argv: &[String]) {
    let files: Vec<String> = argv
        .iter()
        .skip(1)
        .filter(|argument| !argument.starts_with('-'))
        .filter(|argument| std::path::Path::new(argument).is_file())
        .cloned()
        .collect();

    if files.is_empty() {
        return;
    }
    show_main_window(app);
    let _ = app.emit(EVENT_OPEN_FILE, files);
}

/// Файлы, которые ОС попросила открыть НЕ аргументами командной строки.
///
/// Так делает macOS: двойной щелчок по `.md` не перезапускает приложение с
/// путём в argv, а шлёт Apple Event уже работающему процессу. Tauri отдаёт
/// его как `RunEvent::Opened` со списком адресов — почти всегда `file://`.
///
/// Без этой дороги ассоциация файлов на macOS ЧИСЛИТСЯ и не работает: система
/// показывает ЗАПИСКИ в «Открыть с помощью», приложение поднимается и ничего
/// не открывает.
pub fn forward_opened_urls<R: Runtime>(app: &AppHandle<R>, urls: &[tauri::Url]) {
    let mut files: Vec<String> = Vec::new();
    for url in urls {
        if url.scheme() == "file" {
            if let Ok(path) = url.to_file_path() {
                if path.is_file() {
                    files.push(path.to_string_lossy().into_owned());
                }
            }
            continue;
        }
        /* Своя схема приходит той же дорогой — это возврат после входа. */
        if url.scheme() == "zapiski" {
            crate::auth::deliver(app, vec![url.to_string()]);
        }
    }

    if files.is_empty() {
        return;
    }
    show_main_window(app);
    let _ = app.emit(EVENT_OPEN_FILE, files);
}

/// Прочитать байты файла, на который указывает `AppIntent.open-file`.
///
/// Путь снаружи vault'а — обычный `std::fs::read`, а не `@tauri-apps/plugin-fs`
/// из вебвью: скоуп плагина открыт только на каталог хранилища
/// (`vault_open`), и путь к файлу с рабочего стола под него не подходит.
/// `Ok(None)` — файл переместили или удалили между запуском и чтением; не
/// ошибка, потому что решать, что сказать человеку, — дело `packages/app`
/// (ARCHITECTURE §1), а не оболочки.
#[tauri::command]
pub fn read_opened_file(path: String) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{path}: {error}")),
    }
}

/// Какая система под приложением.
///
/// Оболочка одна на Windows и macOS, а различий между ними хватает: своя
/// строка заголовка против системного «светофора», `Ctrl` против `Cmd`,
/// реестр против login item. Фронтенду это нужно знать НАВЕРНЯКА, а не
/// угадывать по `navigator.userAgent`, поэтому платформу называет оболочка.
#[tauri::command]
pub fn host_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Запущено ли приложение из автозапуска (то есть должно остаться в трее).
pub fn started_in_tray(argv: &[String]) -> bool {
    argv.iter().any(|argument| argument == TRAY_ARG)
}

/// Сохранить положение и размер окна.
///
/// Плагин делает это сам при закрытии окна, но выход из трея закрывает
/// процесс, минуя окно, — тогда геометрия последнего сеанса потерялась бы.
pub fn save_window_state<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = app.save_window_state(StateFlags::all());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn узнаёт_запуск_в_трей() {
        assert!(started_in_tray(&["zapiski.exe".into(), TRAY_ARG.into()]));
        assert!(!started_in_tray(&["zapiski.exe".into()]));
    }

    #[test]
    fn читает_открытый_файл_снаружи_vault() {
        let dir = std::env::temp_dir().join(format!("zapiski-open-file-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Идея.md");
        std::fs::write(&path, "# Идея\n").unwrap();

        let bytes = read_opened_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(bytes.as_deref(), Some("# Идея\n".as_bytes()));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn пропавший_файл_не_ошибка() {
        /* Между запуском и чтением файл могли переместить или удалить —
           не exception, а честный `None`: решать, что сказать человеку,
           дело продукта, а не оболочки. */
        let missing = std::env::temp_dir().join("zapiski-open-file-test-missing.md");
        let bytes = read_opened_file(missing.to_string_lossy().into_owned()).unwrap();
        assert_eq!(bytes, None);
    }
}
