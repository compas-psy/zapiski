//! Возврат после входа: deep-link `zapiski://`.
//!
//! Механизм Windows таков: браузер, встретив нашу схему, запускает
//! `zapiski.exe zapiski://auth/callback#access_token=…`. Если приложение уже
//! работает, это второй процесс — его аргументы забирает
//! `tauri-plugin-single-instance` и передаёт живому окну (второе окно
//! поднимать нельзя: vault один, и две копии над одним каталогом — это
//! конфликт записи, а не удобство).
//!
//! Поэтому ссылка приезжает тремя дорогами, и все три сходятся здесь:
//!   • холодный старт — аргументы командной строки в `setup`;
//!   • второй запуск — аргументы из `single-instance`;
//!   • живое приложение — событие плагина `deep-link`.
//!
//! Очередь нужна по той же причине, что и в share-target на Android: ссылка
//! приходит раньше, чем фронтенд успевает подписаться. Всё, что пришло до
//! подписки, лежит здесь и забирается командой `auth_take` — один раз.
//!
//! Токена в журнале нет и быть не может: адрес наружу не печатается ни на
//! одном пути. Это не украшение — `zapiski://…#access_token=…` в логе
//! равносилен утечке сессии.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime};

/// Схема, зарегистрированная в `tauri.conf.json` → `plugins.deep-link`.
pub const SCHEME: &str = "zapiski://";

/// Событие фронтенду: пришёл возврат после входа.
pub const EVENT_AUTH_CALLBACK: &str = "zapiski://auth-callback";

/// Ссылки, которые ещё никто не забрал.
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Отобрать из аргументов то, что похоже на наш deep-link.
///
/// Чистая функция — её и проверяет тест: разбор аргументов командной строки
/// это единственное место, куда попадает содержимое чужого адреса.
pub fn deep_links(argv: &[String]) -> Vec<String> {
    argv.iter()
        .filter(|argument| {
            argument.len() > SCHEME.len() && argument.to_ascii_lowercase().starts_with(SCHEME)
        })
        .cloned()
        .collect()
}

/// Положить ссылку в очередь и, если фронтенд уже жив, сразу отдать её.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    crate::platform::show_main_window(app);
    if let Ok(mut pending) = PENDING.lock() {
        pending.extend(urls.clone());
    }
    for url in urls {
        // Событие может уйти в пустоту — подписчика ещё нет. Тогда ссылка
        // останется в очереди, и её заберёт `auth_take`.
        let _ = app.emit(EVENT_AUTH_CALLBACK, url);
    }
}

/// Аргументы командной строки → очередь. Зовётся и на старте, и из
/// `single-instance`.
pub fn forward_arguments<R: Runtime>(app: &AppHandle<R>, argv: &[String]) {
    deliver(app, deep_links(argv));
}

/// Забрать накопившееся. Очередь опустошается: одноразовый токен не должен
/// обмениваться дважды.
#[tauri::command(async)]
pub fn auth_take() -> Vec<String> {
    PENDING
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn узнаёт_нашу_схему_среди_аргументов() {
        let argv = vec![
            "zapiski.exe".to_string(),
            "--tray".to_string(),
            "zapiski://auth/callback#access_token=x".to_string(),
        ];
        assert_eq!(
            deep_links(&argv),
            vec!["zapiski://auth/callback#access_token=x".to_string()]
        );
    }

    #[test]
    fn не_принимает_чужие_схемы_и_пустую() {
        let argv = vec![
            "zapiski.exe".to_string(),
            "https://zapiski.cmpas.ru/auth".to_string(),
            "zapiski://".to_string(),
            "C:/Users/marina/Заметки/Идея.md".to_string(),
        ];
        assert!(deep_links(&argv).is_empty());
    }
}
