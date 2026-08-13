/**
 * Какие сворачиваемые блоки сейчас свёрнуты (замечание 12).
 *
 * Свёрнутость — состояние показа, а не текста: в файле `<details>` всегда
 * записан целиком, и заметка, открытая в чужом редакторе или на GitHub,
 * выглядит так же. Поэтому здесь поле состояния, а не правка документа.
 *
 * Ключ — позиция начала блока (`<details>`). Она переживает правки соседнего
 * текста: `mapPos` двигает её вместе с документом, и свёрнутый блок не
 * «перескакивает» на другой, когда выше добавили строку.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';

/** Свернуть/развернуть блок, начинающийся в этой позиции. */
export const toggleCollapsed = StateEffect.define<number>();

export const collapsedField = StateField.define<ReadonlySet<number>>({
  create: () => new Set<number>(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const moved = new Set<number>();
      for (const at of value) {
        /* Удалённый вместе с текстом блок отдаёт `null` — тогда он просто
           исчезает из набора, а не остаётся висеть чужой позицией. */
        const mapped = tr.changes.mapPos(at, -1, 0);
        if (mapped !== null) moved.add(mapped);
      }
      next = moved;
    }
    for (const effect of tr.effects) {
      if (!effect.is(toggleCollapsed)) continue;
      const copy = new Set(next);
      if (copy.has(effect.value)) copy.delete(effect.value);
      else copy.add(effect.value);
      next = copy;
    }
    return next;
  },
});

/** Свёрнут ли блок, начинающийся в этой позиции. */
export function isCollapsed(state: EditorState, at: number): boolean {
  return state.field(collapsedField, false)?.has(at) ?? false;
}

export const collapsible: Extension = [collapsedField];
