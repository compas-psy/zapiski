//! Реализация порта `PdfRenderer`.
//!
//! Ядро готовит самодостаточный HTML (`renderPdfSource`), а растеризацию по
//! контракту делает движок печати платформы — «только так кириллица
//! печатается с нормальными шрифтами и переносами»
//! (`packages/core/src/export/pdf.ts`).
//!
//! На Android этот движок — системный конвейер печати: у `WebView` берётся
//! `PrintDocumentAdapter`, и система сама разбивает документ на страницы и
//! пишет PDF. Диалог печати при этом не показывается: контракт требует
//! **байты**, а из диалога байты не возвращаются — оттуда выходит файл,
//! выбранный пользователем. Подробности и запасной путь — в
//! `android/.../PdfPrint.kt`.

use tauri::ipc::Response;

/// `PdfRenderer.render`: HTML на входе, байты PDF на выходе.
///
/// Возвращается `Response` с сырыми байтами: документ на несколько мегабайт,
/// прошедший через JSON-массив чисел, стоил бы дороже самой печати.
#[tauri::command(async)]
pub fn pdf_render(html: String, margin_mm: f64) -> Result<Response, String> {
    if html.is_empty() {
        return Err("нечего печатать".to_owned());
    }
    crate::android::render_pdf(&html, margin_mm).map(Response::new)
}
