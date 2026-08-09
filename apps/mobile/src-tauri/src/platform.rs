//! Мелочи платформы, которые нельзя сделать из webview: FLAG_SECURE, хэптика,
//! доставка share-payload и события фронтенду.
//!
//! Share-target и быстрая заметка приходят из **другого процессного
//! состояния**: «поделиться» и плитка Quick Settings умеют поднимать
//! приложение с нуля. Поэтому и то и другое сначала ложится файлом в
//! `inbox/` (это делает Kotlin), а Rust забирает файл, когда фронтенд уже
//! готов. Живому приложению Kotlin дополнительно стучится через JNI, чтобы
//! контент попал в заметку сразу, а не при следующем запуске.
//!
//! Очередь всегда забирается через `rename`: Kotlin с этого момента пишет в
//! новый файл, и одна и та же картинка не попадёт в заметку дважды.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// ОС передала контент в приложение (BEHAVIOR §8).
pub const EVENT_SHARE: &str = "zapiski://share";
/// Быстрая заметка: плитка Quick Settings или виджет «Записать» 1×1.
pub const EVENT_QUICK_NOTE: &str = "zapiski://quick-note";
/// Прогресс скачивания обновления, доля 0…1.
pub const EVENT_UPDATE_PROGRESS: &str = "zapiski://update-progress";

const INBOX_DIR: &str = "inbox";
const SHARE_QUEUE: &str = "share.jsonl";
const SHARE_TAKEN: &str = "share.taken.jsonl";
/// Пустой файл-отметка: пользователь нажал «Записать».
const QUICK_NOTE_MARK: &str = "quick-note";

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Разобранные payload'ы, которые ещё никому не отдали.
static PENDING: Mutex<Vec<SharedPayload>> = Mutex::new(Vec::new());
/// Забор очереди — «прочитать и опустошить», двумя потоками сразу нельзя.
static DRAIN_LOCK: Mutex<()> = Mutex::new(());

/// То, что пишет Kotlin. Картинку он кладёт во временный файл и передаёт
/// путь: гонять мегабайты фотографии через JNI незачем.
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
}

fn app() -> Option<&'static AppHandle> {
    APP.get()
}

/// Хэндл приложения для тех, кто пришёл из Java и не имеет доступа к
/// состоянию Tauri.
pub fn app_handle() -> Option<AppHandle> {
    APP.get().cloned()
}

fn inbox_dir() -> Option<PathBuf> {
    crate::android::files_dir()
        .ok()
        .flatten()
        .map(|base| PathBuf::from(base).join(INBOX_DIR))
}

/// Разобрать одну строку очереди. Отдельная функция — потому что это
/// единственное место, где мы доверяем данным из чужого приложения, и его
/// нужно уметь проверить тестом.
///
/// Разбор терпимый: неизвестный `kind` или битый JSON просто игнорируются.
/// Уронить приложение из-за странного intent'а нельзя — intent приходит
/// извне, и доверия к нему нет.
fn parse_intent(line: &str) -> Option<SharedPayload> {
    let intent: SharedIntent = serde_json::from_str(line).ok()?;
    if !matches!(intent.kind.as_str(), "text" | "link" | "image") {
        return None;
    }

    // Картинка приезжает файлом: читаем и сразу убираем за собой — временная
    // копия чужой фотографии не должна оставаться в кэше.
    let bytes = intent.path.as_deref().and_then(|path| {
        let data = std::fs::read(path).ok();
        let _ = std::fs::remove_file(path);
        data
    });

    Some(SharedPayload {
        kind: intent.kind,
        text: intent.text,
        url: intent.url,
        bytes,
        mime: intent.mime,
    })
}

/// Забрать файл очереди и разложить его в память.
fn collect_from_disk() {
    let _guard = DRAIN_LOCK.lock();
    let Some(directory) = inbox_dir() else {
        return;
    };

    let queue = directory.join(SHARE_QUEUE);
    let taken = directory.join(SHARE_TAKEN);
    if std::fs::rename(&queue, &taken).is_err() {
        return;
    }
    let content = std::fs::read_to_string(&taken).unwrap_or_default();
    let _ = std::fs::remove_file(&taken);

    let parsed: Vec<SharedPayload> = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_intent)
        .collect();

    if let Ok(mut pending) = PENDING.lock() {
        pending.extend(parsed);
    }
}

fn take_pending() -> Vec<SharedPayload> {
    PENDING
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

/// Kotlin сообщил, что в очереди что-то появилось, и приложение живо.
pub fn poke_share() {
    collect_from_disk();
    let Some(handle) = app() else {
        return;
    };
    for payload in take_pending() {
        let _ = handle.emit(EVENT_SHARE, payload);
    }
}

/// Тап по плитке Quick Settings или виджету «Записать» при живом приложении.
pub fn emit_quick_note() {
    if let Some(handle) = app() {
        let _ = handle.emit(EVENT_QUICK_NOTE, ());
    }
}

/// Отметка «нажали „Записать“», оставленная до запуска приложения.
///
/// Проверяется в момент, когда фронтенд заведомо жив, — то есть из команд,
/// которые он зовёт на старте. Отправлять событие раньше бессмысленно:
/// подписчиков ещё нет, и событие потеряется.
pub fn flush_quick_note() {
    let Some(directory) = inbox_dir() else {
        return;
    };
    let mark = directory.join(QUICK_NOTE_MARK);
    if mark.exists() {
        let _ = std::fs::remove_file(&mark);
        emit_quick_note();
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
    collect_from_disk();
    flush_quick_note();
    take_pending()
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
    fn принимает_текст_и_ссылку() {
        let text = parse_intent(r#"{"kind":"text","text":"Привет"}"#).expect("текст");
        assert_eq!(text.kind, "text");
        assert_eq!(text.text.as_deref(), Some("Привет"));

        let link = parse_intent(r#"{"kind":"link","url":"https://cmpas.ru","text":"КОМПАС"}"#)
            .expect("ссылка");
        assert_eq!(link.url.as_deref(), Some("https://cmpas.ru"));
    }

    #[test]
    fn отвергает_чужое_и_битое() {
        // Битый JSON, обрыв записи и незнакомый тип не должны ни падать, ни
        // попадать в очередь: intent приходит от произвольного приложения.
        assert!(parse_intent("не json").is_none());
        assert!(parse_intent(r#"{"kind":"text","te"#).is_none());
        assert!(parse_intent(r#"{"kind":"video","path":"/sdcard/x.mp4"}"#).is_none());
    }
}
