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

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, Runtime};

const NAME_HEADER: &str = "x-file-name";
const MIME_HEADER: &str = "x-file-mime";

#[tauri::command]
pub async fn save_file<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<(), String> {
    let name = header(&request, NAME_HEADER)?;
    let mime = header(&request, MIME_HEADER)?;

    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => return Err("тело запроса должно быть бинарным".to_owned()),
    };

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
