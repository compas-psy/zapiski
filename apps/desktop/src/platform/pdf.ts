/**
 * Порт `PdfRenderer` — печать через движок вебвью.
 *
 * Ядро готовит самодостаточный HTML (`renderPdfSource`), а растеризацию по
 * контракту делает платформа: «только так кириллица печатается с нормальными
 * шрифтами и переносами» (`packages/core/src/export/pdf.ts`). На Windows этим
 * движком является WebView2 — `ICoreWebView2_7::PrintToPdf` в
 * `src-tauri/src/print.rs`.
 *
 * Системный диалог печати здесь не годится: контракт требует вернуть **байты**,
 * а диалог возвращает файл, выбранный пользователем.
 */
import { invoke } from '@tauri-apps/api/core';
import type { PdfPageSetup, PdfRenderer } from '@zapiski/core';

export class WebviewPdfRenderer implements PdfRenderer {
  /**
   * `setup` не передаётся в Rust намеренно: колонка, поля и светлая тема
   * «Бумага» уже вшиты ядром в сам HTML (`@page` + инлайновые стили).
   * Продублировать их параметрами печати значило бы завести второй источник
   * правды для разметки страницы.
   */
  async render(html: string, _setup: PdfPageSetup): Promise<Uint8Array> {
    const bytes = await invoke<ArrayBuffer>('pdf_render', { html });
    return new Uint8Array(bytes);
  }
}
