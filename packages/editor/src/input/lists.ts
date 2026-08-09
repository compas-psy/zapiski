/**
 * Списки: Enter, Tab/Shift+Tab, Backspace (BEHAVIOR §2.1).
 *
 * Enter и Backspace делегируются `@codemirror/lang-markdown`
 * (`insertNewlineContinueMarkup` — продолжает список тем же маркером и выходит
 * из него на пустом элементе; `deleteMarkupBackward` — снимает маркер, не
 * удаляя строку). Вложенность до 6 уровней — своя: ни одна библиотека не знает
 * про наш предел.
 */

import { insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import type { StateCommand } from '@codemirror/state';

/** Элемент списка любого вида, включая задачи. */
const LIST_ITEM = /^([\t ]*)((?:[-*+]|\d+[.)])[\t ]+)/;
/** Шаг вложенности: два пробела — минимум, который markdown понимает как уровень. */
const STEP = '  ';
/** Предел вложенности из BEHAVIOR §2.1. */
export const MAX_LIST_DEPTH = 6;

function depthOf(indent: string): number {
  // Табуляция считается за один шаг, пробелы — по два.
  let spaces = 0;
  for (const ch of indent) spaces += ch === '\t' ? STEP.length : 1;
  return Math.floor(spaces / STEP.length);
}

/** Enter в списке: следующий элемент того же типа; на пустом — выход из списка. */
export const listNewline: StateCommand = insertNewlineContinueMarkup;

/** Backspace в начале элемента списка снимает маркер, не удаляя строку. */
export const listBackspace: StateCommand = deleteMarkupBackward;

/** Tab — увеличить вложенность выделенных элементов списка (до 6 уровней). */
export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const changes: { from: number; insert: string }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const match = LIST_ITEM.exec(line.text);
      if (!match) continue;
      if (depthOf(match[1] ?? '') >= MAX_LIST_DEPTH - 1) continue;
      changes.push({ from: line.from, insert: STEP });
    }
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: 'input.indent', scrollIntoView: true }));
  return true;
};

/** Shift+Tab — уменьшить вложенность. */
export const dedentListItem: StateCommand = ({ state, dispatch }) => {
  const changes: { from: number; to: number }[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      const match = LIST_ITEM.exec(line.text);
      const indent = match?.[1];
      if (!indent) continue;
      const remove = indent.startsWith('\t') ? 1 : Math.min(STEP.length, indent.length);
      changes.push({ from: line.from, to: line.from + remove });
    }
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: 'delete.dedent', scrollIntoView: true }));
  return true;
};
