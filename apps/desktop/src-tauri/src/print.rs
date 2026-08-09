//! Реализация порта `PdfRenderer`.
//!
//! Ядро готовит самодостаточный HTML (`renderPdfSource`), а растеризацию по
//! контракту делает движок печати платформы — «только так кириллица
//! печатается с нормальными шрифтами и переносами»
//! (`packages/core/src/export/pdf.ts`).
//!
//! На Windows этим движком является WebView2: `ICoreWebView2_7::PrintToPdf`
//! печатает страницу в файл без единого диалога. Показывать системный диалог
//! печати здесь нельзя — контракт требует вернуть **байты**, а из диалога
//! байты не возвращаются, оттуда выходит файл, выбранный пользователем.
//!
//! Схема: скрытое окно с временным HTML → `PrintToPdf` во временный файл →
//! чтение байтов → уборка. Временные файлы лежат в кэше приложения и
//! удаляются в любом исходе, включая ошибочный: печатается расшифрованная
//! заметка, и оставлять её на диске нельзя (BEHAVIOR §5.3).
//!
//! ⚠️ Windows-ветка скомпилирована под `x86_64-pc-windows-msvc`, но не
//! исполнялась: в окружении сборки нет Windows.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime};

/// Сколько ждём загрузку печатного документа. Документ локальный и без
/// сетевых обращений, поэтому секунды здесь — запас, а не норма.
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// Сколько ждём саму печать. Крупная заметка с картинками рисуется дольше.
/// Используется только в windows-ветке `print_window`; под linux (там
/// проверяется компиляция) печати нет, и константа остаётся невостребованной.
#[cfg_attr(not(windows), allow(dead_code))]
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);

/// `PdfRenderer.render`: HTML на входе, байты PDF на выходе.
///
/// Возвращается `Response` с сырыми байтами: PDF на несколько мегабайт,
/// прошедший через JSON-массив чисел, стоил бы дороже самой печати.
#[tauri::command(async)]
pub fn pdf_render<R: Runtime>(app: AppHandle<R>, html: String) -> Result<Response, String> {
    let workspace = Workspace::new(&app)?;
    std::fs::write(&workspace.html, html.as_bytes())
        .map_err(|error| format!("{}: {error}", workspace.html.display()))?;

    let bytes = render(&app, &workspace);
    // Уборка до возврата результата — и после ошибки тоже.
    workspace.cleanup();
    bytes.map(Response::new)
}

/// Пара временных файлов одного задания печати.
struct Workspace {
    html: PathBuf,
    pdf: PathBuf,
    label: String,
}

impl Workspace {
    fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("нет кэш-каталога приложения: {error}"))?
            .join("print");
        std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);

        Ok(Self {
            html: dir.join(format!("{stamp}.html")),
            pdf: dir.join(format!("{stamp}.pdf")),
            label: format!("print-{stamp}"),
        })
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.html);
        let _ = std::fs::remove_file(&self.pdf);
    }
}

fn render<R: Runtime>(app: &AppHandle<R>, workspace: &Workspace) -> Result<Vec<u8>, String> {
    let window = open_print_window(app, workspace)?;
    let result = print_window(&window, &workspace.pdf);
    // Окно закрывается в любом случае: невидимое зависшее окно удержало бы
    // процесс живым после выхода.
    let _ = window.close();
    result?;

    std::fs::read(&workspace.pdf).map_err(|error| format!("{}: {error}", workspace.pdf.display()))
}

/// Скрытое окно с печатным документом.
///
/// Это не экран приложения: в нём нет ни одного элемента интерфейса, только
/// HTML, который сгенерировало ядро, и пользователь его никогда не видит.
fn open_print_window<R: Runtime>(
    app: &AppHandle<R>,
    workspace: &Workspace,
) -> Result<tauri::WebviewWindow<R>, String> {
    use tauri::webview::PageLoadEvent;
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let url = tauri::Url::from_file_path(&workspace.html)
        .map_err(|_| format!("некорректный путь {}", workspace.html.display()))?;

    let (loaded_tx, loaded_rx) = std::sync::mpsc::channel::<()>();
    let window = WebviewWindowBuilder::new(app, &workspace.label, WebviewUrl::External(url))
        .visible(false)
        .skip_taskbar(true)
        .title("")
        // Ширина колонки печати — 640 (BEHAVIOR §9). Ширина окна на неё не
        // влияет (разметку задаёт @page в самом документе), но узкое окно
        // заставило бы движок считать раскладку дважды.
        .inner_size(900.0, 1200.0)
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = loaded_tx.send(());
            }
        })
        .build()
        .map_err(|error| format!("не удалось открыть окно печати: {error}"))?;

    match loaded_rx.recv_timeout(LOAD_TIMEOUT) {
        Ok(()) => Ok(window),
        Err(_) => {
            let _ = window.close();
            Err("печатный документ не успел загрузиться".to_owned())
        }
    }
}

#[cfg(windows)]
fn print_window<R: Runtime>(window: &tauri::WebviewWindow<R>, pdf: &Path) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PrintSettings, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    let (done_tx, done_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let target = HSTRING::from(pdf.as_os_str());
    let setup_tx = done_tx.clone();

    window
        .with_webview(move |webview| {
            let outcome = (|| -> Result<(), String> {
                let controller = webview.controller();
                let core = unsafe { controller.CoreWebView2() }
                    .map_err(|error| format!("нет объекта WebView2: {error}"))?;
                // ICoreWebView2_7 появился в WebView2 Runtime 1.0.1108.44.
                // Runtime ставится вместе с приложением (Tauri тянет
                // WebView2 Bootstrapper), поэтому каст не должен падать;
                // если всё же упал — честно сообщаем, а не печатаем пустоту.
                let printable: ICoreWebView2_7 = core
                    .cast()
                    .map_err(|error| format!("этот WebView2 не умеет печатать в PDF: {error}"))?;

                let finish_tx = done_tx.clone();
                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |result, is_successful| {
                        let outcome = if result.is_ok() && is_successful.as_bool() {
                            Ok(())
                        } else {
                            Err(format!("движок печати вернул ошибку: {result:?}"))
                        };
                        let _ = finish_tx.send(outcome);
                        Ok(())
                    },
                ));

                unsafe {
                    printable.PrintToPdf(
                        PCWSTR(target.as_ptr()),
                        None::<&ICoreWebView2PrintSettings>,
                        &handler,
                    )
                }
                .map_err(|error| format!("не удалось начать печать: {error}"))
            })();

            // Если до вызова PrintToPdf дело не дошло, обработчик не вызовут
            // никогда — сообщаем об ошибке сами, иначе ждать до таймаута.
            if let Err(message) = outcome {
                let _ = setup_tx.send(Err(message));
            }
        })
        .map_err(|error| format!("нет доступа к вебвью: {error}"))?;

    done_rx
        .recv_timeout(PRINT_TIMEOUT)
        .map_err(|_| "печать не завершилась за отведённое время".to_owned())?
}

/// Печать в PDF реализована только на Windows: это оболочка Windows, а под
/// linux она собирается лишь для проверки компиляции.
#[cfg(not(windows))]
fn print_window<R: Runtime>(_window: &tauri::WebviewWindow<R>, _pdf: &Path) -> Result<(), String> {
    Err("печать в PDF доступна только на Windows".to_owned())
}
