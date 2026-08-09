/**
 * `PdfRenderer` для веба — печать (ARCHITECTURE §2, BEHAVIOR §9).
 *
 * Ядро отдаёт самодостаточный печатный HTML (всегда светлая «Бумага», колонка
 * 640, без интерфейсных элементов), а растеризацию делает движок печати
 * браузера. Это единственный честный способ получить кириллицу с нормальными
 * шрифтами и переносами — свой растеризатор в бандл не тянем.
 *
 * Байтов PDF у страницы при этом нет и быть не может: файл сохраняет сам
 * браузер через системный диалог печати. Поэтому `render` возвращает пустой
 * массив — вызывающая сторона в этом случае ничего не «скачивает» повторно.
 */
import type { PdfPageSetup, PdfRenderer } from '@zapiski/core';

const EMPTY = new Uint8Array(0);

export function createPrintPdfRenderer(): PdfRenderer {
  return {
    async render(html: string, setup: PdfPageSetup): Promise<Uint8Array> {
      if (typeof document === 'undefined') return EMPTY;

      const frame = document.createElement('iframe');
      /* Кадр не должен влиять на раскладку страницы и попадать в скриншоты. */
      frame.setAttribute('aria-hidden', 'true');
      frame.style.position = 'fixed';
      frame.style.inlineSize = '0';
      frame.style.blockSize = '0';
      frame.style.border = '0';
      frame.style.visibility = 'hidden';
      document.body.appendChild(frame);

      const doc = frame.contentDocument;
      const view = frame.contentWindow;
      if (!doc || !view) {
        frame.remove();
        return EMPTY;
      }

      doc.open();
      doc.write(html);
      /* Поля страницы — из настроек ядра, а не из вкусов браузера. */
      const page = doc.createElement('style');
      page.textContent = `@page { margin: ${setup.marginMm}mm; }`;
      doc.head.appendChild(page);
      doc.close();

      await new Promise<void>((resolve) => {
        if (doc.readyState === 'complete') resolve();
        else view.addEventListener('load', () => resolve(), { once: true });
      });

      view.focus();
      view.print();

      /* Диалог печати модальный: к этому моменту пользователь уже закрыл его. */
      frame.remove();
      return EMPTY;
    },
  };
}

/**
 * «Скачать файл» — платформенная часть экспорта: ядро отдаёт байты, браузер
 * кладёт их пользователю.
 */
export async function saveFile(name: string, data: Uint8Array, mime: string): Promise<void> {
  if (data.byteLength === 0) return;
  const blob = new Blob([data.slice().buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  /* Ссылку освобождаем не сразу: Safari отменяет скачивание, если поспешить. */
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
