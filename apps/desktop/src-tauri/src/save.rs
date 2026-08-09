//! `AppHost.saveFile` — отдать готовый файл пользователю.
//!
//! Экспорт (BEHAVIOR §9) собирает байты в ядре: markdown, HTML, PDF, DOCX,
//! ZIP. Записать их наружу может только платформа, и на Windows это
//! системный диалог «Сохранить как».
//!
//! Почему диалог открывает Rust, а не фронтенд через `plugin-dialog`.
//! Тогда путь выбирал бы вебвью, а команда записи принимала бы любой путь,
//! который ей передадут, — то есть любая дыра в вебвью превращалась бы в
//! запись в произвольное место диска. Здесь путь никогда не покидает Rust:
//! вебвью передаёт только имя по умолчанию и байты, а куда лечь файлу,
//! решает пользователь в диалоге ОС.
//!
//! За пределы vault'а пишет только эта команда; `fs:allow-write-file`
//! фронтенду не выдан вовсе (см. `capabilities/default.json`).

use std::path::Path;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Имя файла по умолчанию. Percent-encoded — заголовки допускают только ASCII.
const NAME_HEADER: &str = "x-save-name";

/// Возвращает `false`, если пользователь закрыл диалог: это не ошибка, и
/// показывать ему сообщение не нужно.
#[tauri::command]
pub async fn save_file<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<bool, String> {
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("в запросе нет заголовка {NAME_HEADER}"))?;
    let name = crate::vault::percent_decode(name)?;

    let data = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("тело запроса должно быть бинарным".to_owned()),
    };

    let mut builder = app.dialog().file().set_file_name(&name);
    // Фильтр по расширению — чтобы диалог сам подставил его, если
    // пользователь сотрёт имя целиком.
    if let Some(extension) = Path::new(&name).extension().and_then(|value| value.to_str()) {
        builder = builder.add_filter(extension.to_uppercase(), &[extension]);
    }

    // Диалог модальный и отвечает через колбэк; ждём ответа, не блокируя
    // поток, на котором крутится вебвью.
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    builder.save_file(move |path| {
        let _ = sender.blocking_send(path);
    });

    let Some(picked) = receiver.recv().await.flatten() else {
        return Ok(false);
    };
    let path = picked
        .into_path()
        .map_err(|error| format!("некорректный путь: {error}"))?;

    // Экспорт — не заметка vault'а, атомарность здесь не требуется: файл
    // создаётся заново, и прерванная запись не портит ничего существующего.
    std::fs::write(&path, &data).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(true)
}
