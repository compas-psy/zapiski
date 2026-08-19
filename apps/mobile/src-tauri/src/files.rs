//! `AppHost.saveFile` — отдать готовый файл пользователю.
//!
//! Экспорт (BEHAVIOR §9) устроен так: ядро собирает байты (md, zip, html,
//! docx) или печатает PDF, а положить их наружу может только платформа.
//!
//! На Android «наружу» — это каталог «Загрузки». Начиная с Android 10 туда
//! пишут через MediaStore и без единого разрешения; файл виден в «Файлах», в
//! шторке загрузок и с компьютера. Разрешение `WRITE_EXTERNAL_STORAGE` не
//! запрашивается вообще — оно даёт доступ ко всей памяти устройства ради
//! одного файла, и продукту с обещанием приватности это не к лицу.
//!
//! Байты едут сырым телом запроса, имя и MIME — заголовками: экспорт vault'а
//! в zip легко весит десятки мегабайт, а JSON-массив чисел утроил бы и время,
//! и пиковую память.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime};

const NAME_HEADER: &str = "x-file-name";
const MIME_HEADER: &str = "x-file-mime";

#[tauri::command]
pub async fn save_file<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<(), String> {
    let name = header(&request, NAME_HEADER)?;
    let mime = header(&request, MIME_HEADER)?;

    /* На Android сырого тела не бывает в принципе — см. `body.rs`. */
    let data = crate::body::request_bytes(&request)?;

    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        // Имя приходит из заголовка заметки, то есть из текста пользователя.
        // Слэш в нём означал бы запись не туда, куда собирались.
        return Err(format!("недопустимое имя файла: {name}"));
    }

    // Промежуточный файл в кэше: через JNI едет путь, а не мегабайты.
    let staging = staging_path(&app, &name)?;
    if let Some(parent) = staging.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    std::fs::write(&staging, data).map_err(|error| format!("{}: {error}", staging.display()))?;

    let result = crate::android::save_to_downloads(&name, &mime, &staging.to_string_lossy());
    // Убираем за собой в любом исходе: экспортированная заметка — это тот же
    // текст заметки, и лишней копии в кэше ему быть не должно (BEHAVIOR §5.3).
    let _ = std::fs::remove_file(&staging);
    result
}

/// Каталог, из которого FileProvider отдаёт вложения получателю.
///
/// Он же объявлен в `res/xml/file_provider_paths.xml`: путь вне его провайдер
/// отдать откажется, и «поделиться» молча выродится в отправку одного текста.
const SHARE_DIR: &str = "share";

/// Сколько живёт временная копия вложения.
///
/// Удалить её сразу после `startActivity` нельзя: получатель читает файл
/// ПОЗЖЕ, уже из своего процесса, и удаление на месте отдало бы ему пустоту.
/// Поэтому прибираем не за собой, а за прошлым разом — на следующей отправке.
const SHARE_TTL_SECS: u64 = 60 * 60;

/// Положить вложение во временный файл и вернуть путь к нему.
///
/// Байты едут сырым телом по той же причине, что у `save_file`: снимок с
/// телефона весит мегабайты, а JSON-массив чисел утроил бы время и память.
#[tauri::command]
pub async fn share_stage<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<String, String> {
    let name = header(&request, NAME_HEADER)?;
    let data = crate::body::request_bytes(&request)?;

    /* Имя приходит из имени файла вложения, то есть из пользовательского
       текста. Слэш в нём означал бы запись не туда, куда собирались. */
    let safe = name.replace(['/', '\\'], "_");
    let safe = safe.trim_start_matches('.');
    let safe = if safe.is_empty() { "attachment" } else { safe };

    let dir = share_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    sweep(&dir);

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let file = dir.join(format!("{stamp}-{safe}"));
    std::fs::write(&file, data).map_err(|error| format!("{}: {error}", file.display()))?;
    Ok(file.to_string_lossy().into_owned())
}

fn share_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = crate::android::cache_dir()
        .ok()
        .flatten()
        .map(PathBuf::from)
        .or_else(|| app.path().app_cache_dir().ok())
        .ok_or_else(|| "не удалось определить кэш приложения".to_owned())?;
    Ok(base.join(SHARE_DIR))
}

/// Убрать копии прошлых отправок. Молча: это уборка, а не работа человека.
fn sweep(dir: &PathBuf) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .map(|age| age.as_secs() > SHARE_TTL_SECS)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("в запросе нет заголовка {name}"))?;
    crate::vault::percent_decode(raw)
}

fn staging_path<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, String> {
    let base = crate::android::cache_dir()
        .ok()
        .flatten()
        .map(PathBuf::from)
        .or_else(|| app.path().app_cache_dir().ok())
        .ok_or_else(|| "не удалось определить кэш приложения".to_owned())?;

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);

    Ok(base.join("export").join(format!("{stamp}-{name}")))
}
