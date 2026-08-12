/**
 * Ужимание крупных изображений (ITERATION-1 §5).
 *
 * Снимок с телефона — это 4000 px по длинной стороне и 4–8 МБ. В заметке от
 * него видно ширину колонки, то есть меньше тысячи пикселей; остальное лежит
 * в хранилище, ездит через синхронизацию и попадает в резервную копию. §5
 * поэтому и ставит «Ужимать до 2048 px» умолчанием, а не опцией для знатоков.
 *
 * Три правила, которые здесь важнее кода.
 *
 * 1. **Не тронуть то, что сломается.** GIF ужимать нельзя: canvas отдаст
 *    первый кадр, и анимация исчезнет молча. SVG — вектор, у него нет
 *    «пикселей по длинной стороне», а растеризация превратит его в картинку.
 *    Оба остаются как есть.
 *
 * 2. **Формат не меняется.** PNG остаётся PNG, JPEG — JPEG. Иначе поменялось
 *    бы расширение, а вместе с ним и ссылка в тексте: файл, вставленный как
 *    `.png`, вдруг оказался бы `.jpg`.
 *
 * 3. **Отказ — это оригинал, а не ошибка.** Браузер может не уметь декодировать
 *    формат (HEIC с айфона), `OffscreenCanvas` может отсутствовать вовсе.
 *    Тогда кладётся исходный файл: вложение важнее экономии.
 */

/** Длинная сторона, до которой ужимаем. Значение названо в §5. */
export const MAX_SIDE = 2048;

/** Качество JPEG/WebP. 0.9 — граница, за которой артефакты видно на глаз. */
const QUALITY = 0.9;

/** Что умеем пересжимать без потери свойств файла. */
const RESIZABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** MIME по расширению: `File.type` на Android нередко пустой. */
const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function typeOf(file: File): string {
  if (file.type !== '') return file.type;
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  return BY_EXTENSION[ext] ?? '';
}

/**
 * Ужатая копия файла или `null`, если ужимать нечего или нечем.
 *
 * `null` — штатный ответ, а не сбой: вызывающий кладёт оригинал.
 */
export async function downscaleImage(file: File, maxSide = MAX_SIDE): Promise<Blob | null> {
  const type = typeOf(file);
  if (!RESIZABLE.has(type)) return null;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;

  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= maxSide) {
      /* Уже меньше порога: пересжатие только испортило бы — JPEG теряет
         качество на каждом круге, даже когда размер не меняется. */
      bitmap.close();
      return null;
    }

    const scale = maxSide / longest;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type, quality: QUALITY });
    /* Пересжатие иногда даёт файл БОЛЬШЕ исходного — у PNG со скриншота это
       обычное дело. Тогда оригинал честнее: он и меньше, и точнее. */
    return blob.size < file.size ? blob : null;
  } catch {
    /* Формат браузеру не по зубам (HEIC), память кончилась, картинка битая —
       во всех случаях кладём оригинал и молчим: терять вложение из-за
       неудавшейся экономии нельзя. */
    return null;
  }
}
