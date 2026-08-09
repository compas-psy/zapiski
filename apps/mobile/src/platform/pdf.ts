/**
 * `PdfRenderer` — печать средствами Android.
 *
 * По контракту ядра (`packages/core/src/contract.ts`) ядро готовит
 * самодостаточный HTML, а растеризацию делает движок печати платформы:
 * «только так кириллица печатается с нормальными шрифтами и переносами».
 *
 * На Android этот движок — системный конвейер печати: скрытый `WebView` даёт
 * `PrintDocumentAdapter`, которым система рисует страницы в PDF. Подробности и
 * запасной путь — в `android/.../PdfPrint.kt`.
 */
import type { PdfPageSetup, PdfRenderer } from '@zapiski/core';

import { COMMANDS, call } from './ipc';

export function createPdfRenderer(): PdfRenderer {
  return {
    async render(html: string, setup: PdfPageSetup): Promise<Uint8Array> {
      // `setup` уже вшит ядром в сам HTML (@page, ширина колонки, тема
      // «Бумага»). Передаём поля миллиметрами: системному конвейеру они нужны
      // отдельно от разметки документа.
      const buffer = await call<ArrayBuffer>(COMMANDS.pdfRender, {
        html,
        marginMm: setup.marginMm,
      });
      return new Uint8Array(buffer);
    },
  };
}
