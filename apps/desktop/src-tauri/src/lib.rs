//! Оболочка ЗАПИСОК для Windows.
//!
//! ARCHITECTURE §1: в `apps/*` не должно быть ни одного экрана, ни одной
//! кнопки, ни одной строки продуктовой логики. Здесь и нет — только точка
//! входа, реализация платформенных портов (`vault`, `hello`, `hotkey`,
//! `print`) и платформенный манифест (`tauri.conf.json`).

mod auth;
mod hello;
mod hotkey;
mod platform;
mod print;
mod save;
mod tray;
mod vault;

use tauri::{Manager, WindowEvent};

pub fn run() {
    let arguments: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        // Единственный экземпляр — обязательное условие для файловой
        // ассоциации: двойной клик по .md не должен поднимать вторую копию
        // приложения на том же vault'е. Плагин регистрируется первым, иначе
        // вторая копия успеет проинициализировать состояние.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            platform::show_main_window(app);
            platform::forward_file_arguments(app, &argv);
            // Возврат после входа приходит вторым запуском: браузер стартует
            // `zapiski.exe zapiski://auth/callback#…`. Ссылку обязано получить
            // уже открытое окно, а не новая копия приложения.
            auth::forward_arguments(app, &argv);
        }))
        // Положение и размер окна между запусками (требование задачи).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Схема `zapiski://` — единственный способ вернуть браузер в
        // приложение после входа (ТЗ §5.5). Регистрируется установщиком из
        // `tauri.conf.json` → `plugins.deep-link.desktop.schemes`.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Автозапуск — опция и по умолчанию выключена: плагин только даёт
        // возможность включить её, сам он ничего в реестр не пишет.
        // `--tray` заставляет запущенное из автозагрузки приложение остаться
        // в трее и не показывать окно (ТЗ §5.4).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![platform::TRAY_ARG]),
        ))
        .manage(vault::VaultRoot::default())
        .manage(platform::WindowGate::default())
        .invoke_handler(tauri::generate_handler![
            vault::vault_open,
            vault::vault_root,
            vault::vault_write_atomic,
            hotkey::hotkey_register,
            hotkey::hotkey_unregister,
            hello::hello_available,
            hello::hello_enroll,
            hello::hello_unlock,
            hello::hello_remove,
            print::pdf_render,
            save::save_file,
            tray::tray_init,
            platform::shell_ready,
            auth::auth_take,
        ])
        .setup(move |app| {
            // Окно объявлено скрытым в конфиге и показывается по сигналу
            // фронтенда (`shell_ready`): так плагин состояния успевает вернуть
            // ему прошлые размеры, тема применяется до первого кадра, и
            // пользователь не видит ни белой вспышки, ни прыжка окна из центра
            // экрана в своё место. Подстраховка на случай, если фронтенд не
            // подал сигнала, — таймер в `platform`.
            if platform::started_in_tray(&arguments) {
                app.state::<platform::WindowGate>().suppress();
            } else {
                platform::arm_reveal_fallback(app.handle().clone());
            }
            platform::forward_file_arguments(app.handle(), &arguments);

            // Возврат после входа. Три дороги, один приёмник:
            //   • холодный старт по ссылке — аргументы этого процесса;
            //   • то, что плагин уже успел получить до `setup`;
            //   • живое приложение — событие плагина.
            auth::forward_arguments(app.handle(), &arguments);
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // В dev-сборке схема в системе не зарегистрирована (установщик
                // не запускался) — регистрируем на лету, иначе вход нечем
                // проверить до первого выпуска.
                #[cfg(debug_assertions)]
                let _ = app.deep_link().register_all();

                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    auth::deliver(
                        app.handle(),
                        urls.into_iter().map(|url| url.to_string()).collect(),
                    );
                }

                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    auth::deliver(
                        &handle,
                        event.urls().into_iter().map(|url| url.to_string()).collect(),
                    );
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Приложение с включённым автозапуском пользователь заводил
                // как резидентное: закрытие окна прячет его в трей, а не
                // выключает глобальный хоткей до следующего входа в систему.
                // Без автозапуска закрытие означает выход — так же, как в
                // любом обычном окне Windows.
                if tray::is_autostart_enabled(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить ЗАПИСКИ");
}
