/**
 * Кадрирование изображения (замечание 2).
 *
 * «Изображение вставляется, но его нельзя кропить и менять масштаб —
 * получается лажа с большими изображениями». Масштаб решается в разметке
 * (`![подпись|400]`), а обрезка — здесь: она меняет сам файл.
 *
 * Работа идёт над байтами вложения, а не над `blob:`-адресом: результат
 * ложится обратно в хранилище тем же путём, и все ссылки на картинку в
 * заметках остаются рабочими. Формат сохраняется: png остаётся png, jpeg —
 * jpeg. Перекодировать «заодно» нельзя, это чужое решение о чужом файле.
 */

/** Доля от 0 до 1 — так рамка не зависит от того, в каком масштабе её тянули. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Качество для форматов с потерями. То же, что у ужимания при вставке. */
const QUALITY = 0.92;

/** Что умеем перерисовывать. Остальное отдаём как есть — см. `cropImage`. */
const REDRAWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** MIME по расширению: `File.type` на Android часто пуст, а имя есть всегда. */
export function mimeOfPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return '';
}

/**
 * Обрезать картинку по рамке.
 *
 * `null` — обрезать не вышло: формат не перерисовывается (gif, svg, heic),
 * рамка вырождена или движок не дал холста. Это ответ, а не сбой: приложение
 * скажет об этом словами и оставит файл нетронутым.
 */
export async function cropImage(
  bytes: Uint8Array,
  path: string,
  rect: CropRect,
): Promise<Uint8Array | null> {
  const mime = mimeOfPath(path);
  if (!REDRAWABLE.has(mime)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;

  /* Копия буфера: `Uint8Array` из хранилища может быть представлением на
     чужую память, а `Blob` обязан владеть своими байтами. */
  const source = new Blob([bytes.slice()], { type: mime });

  try {
    const bitmap = await createImageBitmap(source);
    const left = Math.round(rect.x * bitmap.width);
    const top = Math.round(rect.y * bitmap.height);
    const width = Math.max(1, Math.round(rect.width * bitmap.width));
    const height = Math.max(1, Math.round(rect.height * bitmap.height));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: mime, quality: QUALITY });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    /* Битый файл, нехватка памяти на огромной картинке, запрет холста —
       снаружи это одно и то же: обрезать не вышло. */
    return null;
  }
}
