/**
 * Пробел на краю начертания выходит из него, а не ломает разметку.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «когда в строке одно слово, ты 2 раза на него топаешь и делаешь
 * жирным, то далее когда печатаешь, например, пробел, то после пробела
 * появляются `**` и каретка не может быть за них перенесена. Таким образом
 * почти невозможно печатать дальше текст. Думаю, так не только с выделением
 * жирным».
 *
 * Так и есть, и причина не в нашей аккуратности, а в самом markdown. После
 * `toggleBold` каретка стоит ВНУТРИ пары маркеров — иначе следующая буква не
 * попала бы в жирное слово. Пробел, набранный там, даёт `**слово **`, а такая
 * запись по CommonMark жирным НЕ является: закрывающая пара не может стоять
 * после пробела. Разметка разваливается, `**` из невидимых становятся обычным
 * текстом, и дальше каждое слово, которое человек печатает, снова оказывается
 * внутри пары — текст «засасывает» в жирное.
 *
 * ── Что делает этот обработчик ──────────────────────────────────────────────
 *
 * Пробел на самом краю начертания печатается СНАРУЖИ пары:
 *
 *     **слово|**   + пробел  →  **слово** |
 *     **|слово**   + пробел  →  | **слово**
 *
 * Ровно так ведут себя редакторы, где разметка живёт в тексте (Bear, Obsidian,
 * Typora): пробел на краю читается как «я закончил выделять», а не как «вставь
 * пробел внутрь и сломай запись».
 *
 * Буквы этого правила НЕ касаются: буква на краю — это «допишу слово», и
 * дописывать её надо внутрь. Правило про пробел, потому что ломает разметку
 * именно пробел.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { isComposing } from '../ime/composition.js';

/**
 * Начертания, у которых пробел на краю ломает запись.
 *
 * Ссылки, теги и html-вставки сюда не входят намеренно: у `[имя](адрес)`,
 * `#тег` и `<u>` пробел внутри границ ничего не разрушает.
 */
const FRAGILE = new Set(['StrongEmphasis', 'Emphasis', 'Strikethrough', 'ZHighlight', 'InlineCode']);

/** Куда переносить ввод: наружу пары или никуда (`null` — печатать как есть). */
function exitAt(state: EditorState, pos: number): number | null {
  const tree = syntaxTree(state);
  /* Смотрим узел «изнутри»: на границе `resolveInner` без подсказки отдал бы
     родителя, и края начертания мы бы не увидели вовсе. */
  for (const side of [-1, 1] as const) {
    let node = tree.resolveInner(pos, side);
    for (let cur: typeof node | null = node; cur; cur = cur.parent) {
      if (!FRAGILE.has(cur.name)) continue;
      /* Длина маркера — по первому и последнему потомку: она разная у `*`,
         `**`, `~~`, `==` и `` ` ``, а считать её по имени узла значило бы
         держать вторую таблицу разметки. */
      const first = cur.firstChild;
      const last = cur.lastChild;
      if (!first || !last || first.from !== cur.from || last.to !== cur.to) continue;
      if (pos === last.from) return cur.to;
      if (pos === first.to) return cur.from;
      return null;
    }
  }
  return null;
}

/**
 * Начертание, ВСЁ содержимое которого попало в выделение.
 *
 * Второй путь того же отчёта: слово осталось выделенным после нажатия «B», и
 * человек сразу печатает пробел. Замена дала бы `** **` — пару маркеров вокруг
 * пробела, то есть ту же сломанную запись. Значит вместе с содержимым уходят и
 * маркеры: выделения без текста не бывает.
 */
function wholeContent(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(from, 1);
  for (let cur: typeof node | null = node; cur; cur = cur.parent) {
    if (!FRAGILE.has(cur.name)) continue;
    const first = cur.firstChild;
    const last = cur.lastChild;
    if (!first || !last || first.from !== cur.from || last.to !== cur.to) return null;
    return from === first.to && to === last.from ? { from: cur.from, to: cur.to } : null;
  }
  return null;
}

/**
 * Пробел у края начертания печатается снаружи.
 *
 * Два случая, и оба из отчёта заказчика: каретка стоит у самого края пары, и
 * пара маркеров осталась вокруг выделенного слова.
 */
export const emphasisExit: Extension = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ') return false;
  /* Композиция ещё идёт — пробел транзитный, выносить его наружу пары рано. */
  if (isComposing(view)) return false;

  if (from !== to) {
    const whole = wholeContent(view.state, from, to);
    if (!whole) return false;
    view.dispatch({
      changes: { from: whole.from, to: whole.to, insert: ' ' },
      selection: { anchor: whole.from + 1 },
      userEvent: 'input.type',
      scrollIntoView: true,
    });
    return true;
  }

  const target = exitAt(view.state, from);
  if (target === null) return false;
  view.dispatch({
    changes: { from: target, insert: ' ' },
    selection: { anchor: target + 1 },
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});
