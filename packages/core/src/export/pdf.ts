/**
 * Экспорт в PDF (ТЗ §5.3, BEHAVIOR §9): всегда светлая тема «Бумага», колонка
 * 640, без интерфейсных элементов.
 *
 * Ядро готовит печатный документ, а саму растеризацию делает платформа —
 * это единственный честный способ получить кириллицу с нормальными шрифтами
 * и переносами: движок печати уже есть в каждой из трёх целей (Chromium в вебе,
 * WebView в Tauri desktop и Android). Порт объявлен здесь, реализации — в
 * `apps/*` (ARCHITECTURE §2: платформа подключается только через порты).
 */
import type { Note, PdfPageSetup, PdfRenderer } from '../contract.js';
import { renderPrintableHtml, type HtmlExportOptions } from './html.js';

/**
 * Настройки печати (BEHAVIOR §9). Реализация порта `PdfRenderer` — в `apps/*`:
 *  • web — печать скрытого iframe;
 *  • desktop/Android — печать WebView в файл через Tauri.
 */
export const PDF_PAGE_SETUP: PdfPageSetup = { columnWidth: 640, marginMm: 18, theme: 'paper' };

export type { PdfPageSetup, PdfRenderer };

/** Готовый к печати документ (он же исходник для HTML-экспорта). */
export function renderPdfSource(note: Note, options: HtmlExportOptions = {}): string {
  return renderPrintableHtml(note, options);
}

export async function exportPdf(note: Note, renderer: PdfRenderer, options: HtmlExportOptions = {}): Promise<Uint8Array> {
  return renderer.render(renderPdfSource(note, options), PDF_PAGE_SETUP);
}
