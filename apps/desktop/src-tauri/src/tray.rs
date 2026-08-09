//! Иконка в трее и её меню (ТЗ §5.4).
//!
//! Подписи приходят из фронтенда: каталоги строк живут в TypeScript, и
//! дублировать их в Rust значило бы завести второй источник правды для
//! перевода. Поэтому трей создаётся не в `setup()`, а по команде `tray_init`,
//! которую оболочка вызывает сразу после старта приложения.

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

pub const TRAY_ID: &str = "zapiski";

const ID_QUICK_NOTE: &str = "quick-note";
const ID_OPEN: &str = "open";
const ID_AUTOSTART: &str = "autostart";
const ID_QUIT: &str = "quit";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub quick_note: String,
    pub open: String,
    pub autostart: String,
    pub quit: String,
    pub tooltip: String,
}

/// Создать (или пересоздать — при смене языка) иконку в трее.
#[tauri::command]
pub fn tray_init<R: Runtime>(app: AppHandle<R>, labels: TrayLabels) -> Result<(), String> {
    // Пересоздание дешевле, чем обход меню и правка подписей по одной.
    if let Some(existing) = app.remove_tray_by_id(TRAY_ID) {
        drop(existing);
    }

    let quick_note = MenuItem::with_id(
        &app,
        ID_QUICK_NOTE,
        &labels.quick_note,
        true,
        None::<&str>,
    )
    .map_err(to_message)?;
    let open = MenuItem::with_id(&app, ID_OPEN, &labels.open, true, None::<&str>).map_err(to_message)?;
    let separator = PredefinedMenuItem::separator(&app).map_err(to_message)?;

    // Автозапуск — ровно опция, и по умолчанию она выключена: плагин ничего
    // не включает сам, галка отражает фактическое состояние в реестре.
    let autostart_enabled = is_autostart_enabled(&app);
    let autostart = CheckMenuItem::with_id(
        &app,
        ID_AUTOSTART,
        &labels.autostart,
        true,
        autostart_enabled,
        None::<&str>,
    )
    .map_err(to_message)?;

    let tail_separator = PredefinedMenuItem::separator(&app).map_err(to_message)?;
    let quit = MenuItem::with_id(&app, ID_QUIT, &labels.quit, true, None::<&str>).map_err(to_message)?;

    let menu = Menu::with_items(
        &app,
        &[
            &quick_note,
            &open,
            &separator,
            &autostart,
            &tail_separator,
            &quit,
        ],
    )
    .map_err(to_message)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(&labels.tooltip)
        .menu(&menu)
        // Левый клик — открыть окно, а не показать меню: это самое частое
        // действие, и лишний шаг здесь раздражал бы.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            if id == ID_QUICK_NOTE {
                crate::platform::quick_note(app);
            } else if id == ID_OPEN {
                crate::platform::show_main_window(app);
            } else if id == ID_AUTOSTART {
                let next = !is_autostart_enabled(app);
                if set_autostart(app, next).is_ok() {
                    let _ = autostart.set_checked(next);
                } else {
                    // Не удалось — галка остаётся в прежнем положении,
                    // а не врёт о включённом автозапуске.
                    let _ = autostart.set_checked(!next);
                }
            } else if id == ID_QUIT {
                crate::platform::save_window_state(app);
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            let opens_window = match event {
                // Отпускание левой кнопки, а не нажатие: иначе окно
                // выпрыгивает раньше, чем пользователь решил, что кликает.
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => true,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => true,
                _ => false,
            };
            if opens_window {
                crate::platform::show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(&app).map(|_| ()).map_err(to_message)
}

pub fn is_autostart_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn set_autostart<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(to_message)
    } else {
        manager.disable().map_err(to_message)
    }
}

fn to_message<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}
