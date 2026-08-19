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
        //
        // ВАЖНО: без `DECORATIONS` и `VISIBLE`. `Builder::default()` берёт
        // `StateFlags::all()`, а среди них есть `DECORATIONS` — плагин
        // записывает состояние рамки в `.window-state.json` и восстанавливает
        // его при старте ПОВЕРХ `"decorations": false` из `tauri.conf.json`.
        //
        // Дефект отсюда ровно такой, каким его увидел заказчик: у тех, кто
        // запускал версию до перехода на свою строку заголовка, в файле
        // состояния лежит `decorations: true`. После обновления плагин
        // возвращает системную рамку, а наша полоса рисуется своим чередом —
        // и в окне оказывается ДВА ряда кнопок «свернуть/развернуть/закрыть».
        // На чистой установке этого не видно, поэтому дефект и переживает
        // сборки: он есть только у обновившихся.
        //
        // `VISIBLE` убран по смежной причине: окно объявлено `visible: false`
        // и показывается вручную (`platform::show_main_window`), чтобы не
        // мигать белым до первого кадра. Закрытие в трей прячет окно, плагин
        // сохранил бы «невидимо» — и следующий запуск начинался бы с окна,
        // которого нет.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all().difference(
                    tauri_plugin_window_state::StateFlags::DECORATIONS
                        | tauri_plugin_window_state::StateFlags::VISIBLE,
                ))
                .build(),
        )
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
            platform::host_os,
        ])
        .setup(move |app| {
            /*
             * Рамки окна: своя строка заголовка на Windows, системный
             * «светофор» на macOS.
             *
             * В конфиге стоит `decorations: true` — и это macOS-случай. Там
             * `titleBarStyle: Overlay` прячет полосу заголовка, оставляя три
             * кнопки слева; `decorations: false` убрало бы и их, и окно стало
             * бы невозможно закрыть мышью.
             *
             * Windows своей строкой заголовка рисует всё сам, поэтому рамки
             * снимаются здесь, в коде: один конфиг двух значений держать не
             * может. Вспышки не будет — окно объявлено скрытым и показывается
             * только по сигналу фронтенда.
             */
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window(platform::MAIN_WINDOW) {
                let _ = window.set_decorations(false);
            }

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
        .build(tauri::generate_context!())
        .expect("не удалось запустить ЗАПИСКИ")
        .run(|_app, _event| {
            /*
             * Двойной щелчок по `.md` на macOS.
             *
             * Windows перезапускает приложение с путём в аргументах — это
             * ловит `forward_file_arguments`. macOS так НЕ делает: она шлёт
             * уже работающему процессу Apple Event, и Tauri отдаёт его здесь.
             * Без этой ветки ассоциация файлов на macOS числится и не
             * работает: приложение поднимается и ничего не открывает.
             */
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                platform::forward_opened_urls(_app, urls);
            }
        });
}
