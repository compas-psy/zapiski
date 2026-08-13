//! Папка пользователя через SAF (Storage Access Framework).
//!
//! ── Зачем это есть ──────────────────────────────────────────────────────────
//!
//! Умолчание на Android — каталог приложения во внешней памяти (`vault.rs`):
//! настоящие файлы `.md` на настоящей ФС, атомарная запись `tmp → fsync →
//! rename`, инвариант ТЗ §4.3 выполнен полностью. Так и остаётся.
//!
//! Но ТЗ §4.1 п. 1 называет ключевым сценарий «LocalFolder — в т.ч. папка,
//! которую синкает сторонний клиент»: человек кладёт заметки в папку
//! Яндекс.Диска и получает синхронизацию бесплатно, без нашего облака. На
//! Android чужая папка доступна только через SAF, а поверх дерева
//! `content://` файловых операций нет — есть `DocumentsContract`. Отказ от
//! SAF ради формального соответствия §4.3 закрывал этот сценарий целиком:
//! формально правильно, продуктово — хуже.
//!
//! Поэтому выбор отдан пользователю, а мы обязаны сделать максимум возможного
//! и честно назвать оставшуюся разницу:
//!
//!   • провайдер умеет `FLAG_SUPPORTS_RENAME` → пишем во временный документ,
//!     затем заменяем целевой (режим `staged`): длинная часть записи
//!     безопасна, окно риска — доли секунды на замене;
//!   • не умеет → пишем прямо в документ (режим `direct`), и интерфейс
//!     говорит об этом прямым текстом.
//!
//! ── Где что живёт ───────────────────────────────────────────────────────────
//!
//! Здесь только команды и разбор аргументов. Всё, что требует Android-API,
//! делает Kotlin (`apps/mobile/android/.../Saf.kt`) через единственный
//! JNI-модуль `android.rs`.

use tauri::ipc::{InvokeBody, Request, Response};

use crate::android;

/// Заголовки сырого запроса записи: дерево и путь внутри него.
const TREE_HEADER: &str = "x-saf-tree";
const PATH_HEADER: &str = "x-vault-path";

/// Выбранное дерево вместе с тем, что о нём известно.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafTree {
    /// `content://…/tree/…` — его же фронтенд кладёт в настройки.
    pub uri: String,
    /// Человекочитаемое имя папки для интерфейса.
    pub label: String,
    /// Провайдер умеет переименование: значит, доступен режим `staged`.
    pub supports_rename: bool,
}

/// Системный выбор папки. `None` — пользователь отменил (это не ошибка,
/// BEHAVIOR §0: отменённое действие сообщений не требует).
#[tauri::command(async)]
pub fn saf_pick() -> Result<Option<SafTree>, String> {
    let Some(uri) = android::saf_pick_folder()? else {
        return Ok(None);
    };
    describe(uri).map(Some)
}

/// Ещё доступно ли дерево, выбранное в прошлый запуск.
///
/// Разрешение на папку пользователь может отозвать в настройках Android, а
/// саму папку — удалить. Тогда честный ответ `None`: приложение вернётся в
/// каталог приложения, а не будет молча писать в пустоту.
#[tauri::command(async)]
pub fn saf_probe(tree: String) -> Result<Option<SafTree>, String> {
    if !android::saf_has_access(&tree)? {
        return Ok(None);
    }
    describe(tree).map(Some)
}

fn describe(uri: String) -> Result<SafTree, String> {
    let label = android::saf_label(&uri)?.unwrap_or_else(|| uri.clone());
    let supports_rename = android::saf_supports_rename(&uri)?;
    Ok(SafTree {
        uri,
        label,
        supports_rename,
    })
}

/// Содержимое каталога — JSON-массив от Java-стороны, он же уезжает наверх.
///
/// Перекладывать его в структуру Rust было бы лишним звеном: ядро всё равно
/// разбирает результат на стороне JS, а формат задан ровно в одном месте.
#[tauri::command(async)]
pub fn saf_list(tree: String, path: String) -> Result<String, String> {
    android::saf_list(&tree, &path)
}

/// Чтение документа. Отсутствие файла — ошибка команды; фронтенд превращает
/// её в `null`, как того требует контракт `VaultStorage.read`.
#[tauri::command(async)]
pub fn saf_read(tree: String, path: String) -> Result<Response, String> {
    let bytes = android::saf_read(&tree, &path)?;
    Ok(Response::new(bytes))
}

/// Запись документа: тело сырое, путь и дерево — в заголовках.
///
/// Как именно пишется, решает Java-сторона: временный документ с заменой,
/// если провайдер умеет переименование, иначе — напрямую. Возвращается
/// фактический режим записи, чтобы интерфейс не обещал больше, чем было.
#[tauri::command]
pub async fn saf_write(request: Request<'_>) -> Result<String, String> {
    let tree = header(&request, TREE_HEADER)?;
    let path = header(&request, PATH_HEADER)?;
    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => return Err("тело запроса должно быть бинарным".to_owned()),
    };
    android::saf_write(&tree, &path, data)
}

#[tauri::command(async)]
pub fn saf_stat(tree: String, path: String) -> Result<Option<String>, String> {
    android::saf_stat(&tree, &path)
}

#[tauri::command(async)]
pub fn saf_mkdir(tree: String, path: String) -> Result<(), String> {
    android::saf_mkdir(&tree, &path)
}

#[tauri::command(async)]
pub fn saf_remove(tree: String, path: String) -> Result<(), String> {
    android::saf_remove(&tree, &path)
}

/// Открыть вложение системным приложением (замечание 16). `false` — нечем.
#[tauri::command(async)]
pub fn saf_open(tree: String, path: String) -> Result<bool, String> {
    android::saf_open(&tree, &path)
}

#[tauri::command(async)]
pub fn saf_rename(tree: String, from: String, to: String) -> Result<(), String> {
    android::saf_rename(&tree, &from, &to)
}

/// Значение заголовка, декодированное из percent-encoding.
///
/// Заголовки допускают только ASCII, а пути в vault'е кириллические —
/// декодер тот же, что у атомарной записи в `vault.rs`.
fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("в запросе нет заголовка {name}"))?;
    crate::vault::percent_decode(raw)
}
