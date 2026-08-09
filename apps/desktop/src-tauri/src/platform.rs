//! Оконные и процессные мелочи, которые нельзя сделать из webview.

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

pub fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
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
}
