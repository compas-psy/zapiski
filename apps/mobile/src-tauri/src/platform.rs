//! Мелочи платформы, которые нельзя сделать из webview: FLAG_SECURE, хэптика,
//! доставка share-payload и события фронтенду.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// ОС передала контент в приложение (BEHAVIOR §8).
pub const EVENT_SHARE: &str = "zapiski://share";
/// Быстрая заметка: плитка Quick Settings или виджет «Записать» 1×1.
pub const EVENT_QUICK_NOTE: &str = "zapiski://quick-note";
/// Прогресс скачивания обновления, доля 0…1.
pub const EVENT_UPDATE_PROGRESS: &str = "zapiski://update-progress";

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Очередь share-payload'ов: «поделиться» может поднять приложение с нуля, и
/// тогда контент приходит раньше, чем фронтенд успевает подписаться.
static INBOX: OnceLock<Mutex<Vec<SharedPayload>>> = OnceLock::new();

/// Тап по плитке произошёл до готовности фронтенда — событие ждёт своего часа.
static QUICK_NOTE_PENDING: AtomicBool = AtomicBool::new(false);

fn inbox() -> &'static Mutex<Vec<SharedPayload>> {
    INBOX.get_or_init(|| Mutex::new(Vec::new()))
}

/// То, что присылает Kotlin. Картинку он кладёт во временный файл и передаёт
/// путь: гонять мегабайты фотографии через JNI-строку незачем.
#[derive(Deserialize)]
struct SharedIntent {
    kind: String,
    text: Option<String>,
    url: Option<String>,
    path: Option<String>,
    mime: Option<String>,
}

/// `SharedPayload` из контракта ядра.
#[derive(Serialize, Clone)]
pub struct SharedPayload {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

pub fn remember_app(handle: AppHandle) {
    let _ = APP.set(handle);
    if QUICK_NOTE_PENDING.swap(false, Ordering::Relaxed) {
        emit_quick_note();
    }
}

fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Разобрать JSON от Kotlin и положить payload в очередь + отправить событие.
///
/// Разбор терпимый: неизвестный `kind` или битый JSON просто игнорируются.
/// Уронить приложение из-за странного intent'а от другой программы нельзя —
/// intent приходит извне и доверия к нему нет.
pub fn accept_share(json: &str) {
    let Ok(intent) = serde_json::from_str::<SharedIntent>(json) else {
        return;
    };
    if !matches!(intent.kind.as_str(), "text" | "link" | "image") {
        return;
    }

    // Картинка приезжает файлом: читаем и сразу убираем за собой — временная
    // копия чужой фотографии не должна оставаться в кэше.
    let bytes = intent.path.as_deref().and_then(|path| {
        let data = std::fs::read(path).ok();
        let _ = std::fs::remove_file(path);
        data
    });

    let payload = SharedPayload {
        kind: intent.kind,
        text: intent.text,
        url: intent.url,
        bytes,
        mime: intent.mime,
    };

    if let Ok(mut queue) = inbox().lock() {
        queue.push(payload.clone());
    }
    if let Some(handle) = app() {
        let _ = handle.emit(EVENT_SHARE, payload);
    }
}

pub fn emit_quick_note() {
    match app() {
        Some(handle) => {
            let _ = handle.emit(EVENT_QUICK_NOTE, ());
        }
        None => QUICK_NOTE_PENDING.store(true, Ordering::Relaxed),
    }
}

pub fn emit_update_progress(fraction: f64) {
    if let Some(handle) = app() {
        let _ = handle.emit(EVENT_UPDATE_PROGRESS, fraction);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Команды
// ─────────────────────────────────────────────────────────────────────────────

/// Забрать накопившиеся share-payload'ы. Очередь опустошается: повторно тот же
/// контент в заметку не попадёт.
#[tauri::command(async)]
pub fn share_take() -> Vec<SharedPayload> {
    inbox()
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

/// FLAG_SECURE (BEHAVIOR §5.3, приёмочный критерий №7).
///
/// Включается, когда открыта расшифрованная заметка, и снимается, когда
/// открытых не осталось. Решение принимает `packages/app`; оболочка только
/// ставит и снимает флаг окна.
#[tauri::command(async)]
pub fn secure_flag(on: bool) -> Result<(), String> {
    crate::android::set_secure(on)
}

/// Хэптика (BEHAVIOR §0). Два значения силы, третьего в контракте нет.
#[tauri::command(async)]
pub fn haptic_impact(strength: String) -> Result<(), String> {
    let code = match strength.as_str() {
        "light" => 0,
        "medium" => 1,
        other => return Err(format!("неизвестная сила импульса: {other}")),
    };
    crate::android::haptic(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn игнорирует_чужой_intent() {
        // Битый JSON и неизвестный тип не должны ни падать, ни попадать в
        // очередь: intent приходит от произвольного приложения.
        accept_share("не json");
        accept_share(r#"{"kind":"video"}"#);
        assert!(inbox().lock().unwrap().is_empty());
    }

    #[test]
    fn принимает_текст_и_ссылку() {
        accept_share(r#"{"kind":"text","text":"Привет"}"#);
        accept_share(r#"{"kind":"link","url":"https://cmpas.ru","text":"КОМПАС"}"#);

        let taken = share_take();
        assert_eq!(taken.len(), 2);
        assert_eq!(taken[0].kind, "text");
        assert_eq!(taken[0].text.as_deref(), Some("Привет"));
        assert_eq!(taken[1].url.as_deref(), Some("https://cmpas.ru"));

        // Очередь опустела: тот же контент не попадёт в заметку дважды.
        assert!(share_take().is_empty());
    }
}
