/**
 * Размер картинки в заметке (замечание 2).
 *
 * ── Почему ширина живёт в подписи ───────────────────────────────────────────
 *
 * В самом markdown размеров нет. Obsidian решает это соглашением
 * `![подпись|400](путь)`, и мы берём то же: придумывать своё значило бы, что
 * заметка с картинкой правильно читается только у нас. Чужой редактор покажет
 * `|400` частью подписи — некрасиво, но не сломано, и файл остаётся файлом.
 *
 * Высоты здесь нет намеренно: колонка текста узкая, картинка масштабируется
 * по ней, а пропорции держит показ.
 */
import type { StateCommand } from '@codemirror/state';

/** `![подпись](путь)` — подпись и путь по отдельности. */
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;

/** Разбор подписи на текст и ширину: `подпись|400`. */
const SIZED = /^(.*?)\|(\d{1,4})$/;

/** Ширина, заданная картинке в тексте; `null` — своя, из файла. */
export function imageWidthOf(alt: string): number | null {
  const found = SIZED.exec(alt);
  return found ? Number(found[2]) : null;
}

/**
 * Задать картинке ширину. `null` — снять ограничение и вернуть исходный
 * размер: «сбросить» здесь честнее, чем подставлять якобы натуральную
 * величину, которой мы не знаем.
 */
export function setImageWidth(path: string, width: number | null): StateCommand {
  return ({ state, dispatch }) => {
    const text = state.doc.toString();
    const changes: { from: number; to: number; insert: string }[] = [];

    IMAGE.lastIndex = 0;
    for (let match = IMAGE.exec(text); match !== null; match = IMAGE.exec(text)) {
      if ((match[2] ?? '') !== path) continue;
      const alt = match[1] ?? '';
      const base = SIZED.exec(alt)?.[1] ?? alt;
      const nextAlt = width === null ? base : `${base}|${width}`;
      if (nextAlt === alt) continue;
      /* Правится ТОЛЬКО подпись: путь и скобки остаются как были, иначе
         пересборка строки задела бы ссылку на файл. */
      const from = match.index + 2;
      changes.push({ from, to: from + alt.length, insert: nextAlt });
    }

    if (changes.length === 0) return false;
    dispatch(state.update({ changes, userEvent: 'input.format' }));
    return true;
  };
}
