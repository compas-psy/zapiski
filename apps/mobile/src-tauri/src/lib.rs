//! Оболочка ЗАПИСОК для Android.
//!
//! ARCHITECTURE §1: в `apps/*` не должно быть ни одного экрана, ни одной
//! кнопки, ни одной строки продуктовой логики. Здесь и нет — только точка
//! входа, реализация платформенных портов (`vault`, `biometrics`, `print`,
//! `updater`, `widgets`, `platform`) и платформенный манифест
//! (`tauri.conf.json` + оверлей `apps/mobile/android`).
//!
//! Всё, что требует Android-API, проходит через `android.rs` — единственный
//! модуль, знающий про JNI. На не-Android целях он возвращает честную ошибку
//! «доступно только на Android», а не тихую заглушку: так компиляция под
//! linux остаётся полезной проверкой, и ни один порт не притворяется
//! работающим там, где его нет.

mod android;
mod biometrics;
mod body;
mod files;
mod platform;
mod print;
mod saf;
mod updater;
mod vault;
mod widgets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(vault::VaultRoot::default())
        .invoke_handler(tauri::generate_handler![
            vault::vault_open,
            vault::vault_root,
            vault::vault_default_root,
            vault::vault_write_atomic,
            /* Папка пользователя через SAF (ТЗ §4.1 п. 1) — см. saf.rs. */
            saf::saf_pick,
            saf::saf_probe,
            saf::saf_persisted,
            saf::saf_release,
            saf::saf_list,
            saf::saf_read,
            saf::saf_write,
            saf::saf_stat,
            saf::saf_mkdir,
            saf::saf_open,
            saf::saf_remove,
            saf::saf_rename,
            platform::secure_flag,
            platform::haptic_impact,
            platform::share_text,
            platform::share_take,
            platform::auth_take,
            biometrics::biometrics_available,
            biometrics::biometrics_enroll,
            biometrics::biometrics_unlock,
            biometrics::biometrics_remove,
            print::pdf_render,
            files::save_file,
            updater::updater_check,
            updater::updater_download_install,
            widgets::widgets_publish,
            widgets::widgets_take_commands,
        ])
        .setup(|app| {
            // Хэндл нужен коллбэкам из Java: они приходят на чужом потоке и
            // должны уметь отправить событие фронтенду.
            platform::remember_app(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить ЗАПИСКИ");
}
