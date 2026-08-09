//! Реализация порта `GlobalHotkeyProvider`.
//!
//! Хоткей регистрируется в ОС, а не в webview: BEHAVIOR §7 требует, чтобы
//! быстрая заметка открывалась «поверх всех окон», в том числе когда
//! приложение свёрнуто и фокуса у него нет.
//!
//! Само сочетание задаёт `packages/app` (по умолчанию Ctrl+Alt+N,
//! настраивается) — оболочка ничего не решает и ничего не рисует: она
//! поднимает окно и отдаёт событие фронтенду.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::platform;

#[tauri::command(async)]
pub fn hotkey_register<R: Runtime>(app: AppHandle<R>, accelerator: String) -> Result<(), String> {
    // Повторная регистрация того же сочетания — не ошибка вызывающего:
    // при смене хоткея в настройках проще перерегистрировать, чем следить
    // за состоянием. Прошлую регистрацию снимаем молча.
    let _ = app.global_shortcut().unregister(accelerator.as_str());

    let announced = accelerator.clone();
    app.global_shortcut()
        .on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
            // Нажатие и отпускание приходят отдельно; реагируем один раз.
            if event.state != ShortcutState::Pressed {
                return;
            }
            platform::show_main_window(app);
            let _ = app.emit(platform::EVENT_HOTKEY, announced.clone());
        })
        .map_err(|error| format!("не удалось занять сочетание {accelerator}: {error}"))
}

#[tauri::command(async)]
pub fn hotkey_unregister<R: Runtime>(app: AppHandle<R>, accelerator: String) -> Result<(), String> {
    app.global_shortcut()
        .unregister(accelerator.as_str())
        .map_err(|error| format!("не удалось освободить сочетание {accelerator}: {error}"))
}
