/**
 * Списки: Enter, Tab/Shift+Tab, Backspace (BEHAVIOR §2.1).
 *
 * Enter и Backspace делегируются `@codemirror/lang-markdown`
 * (`insertNewlineContinueMarkup` — продолжает список тем же маркером и выходит
 * из него на пустом элементе; `deleteMarkupBackward` — снимает маркер, не
 * удаляя строку). Вложенность до 6 уровней — своя: ни одна библиотека не знает
 * про наш предел.
 */

import {
  insertNewlineContinueMarkupCommand,
  deleteMarkupBackward,
} from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, StateCommand } from '@codemirror/state';
import { collapseLineToBlankBoundary } from '../syntax/block-boundary.js';

/** Элемент списка любого вида, включая задачи. */
const LIST_ITEM = /^([\t ]*)((?:[-*+]|\d+[.)])[\t ]+)/;
/** Пустой пункт списка целиком — маркер (и чекбокс задачи, если есть) и ничего больше. */
const EMPTY_LIST_ITEM_LINE = /^([\t ]*)(?:[-*+]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]+)?$/;
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

/** Курсор действительно разобран парсером как `ListItem`, а не просто похож на него текстом. */
function cursorInsideListItem(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'ListItem') return true;
  }
  return false;
}

/**
 * Штатный `insertNewlineContinueMarkupCommand`: следующий элемент того же
 * типа, а на пустом элементе — снятие маркера.
 *
 * `nonTightLists: false` принципиально: с настройкой по умолчанию CodeMirror на
 * пустом втором элементе «разрежает» список, добавляя пустую строку, а
 * BEHAVIOR §2.1 требует именно выхода из списка со снятием маркера.
 */
const continueMarkup: StateCommand = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

/**
 * Enter в списке — с продуктовым выходом на пустом элементе ВЕРХНЕГО уровня.
 *
 * ── Чего не хватало `continueMarkup` ────────────────────────────────────────
 *
 * На пустом элементе штатная команда снимает маркер, но оставляет ровно один
 * `\n` — это НЕ настоящая пустая строка CommonMark, а значит первый же
 * введённый следом символ становится lazy continuation прежнего пункта: список
 * молча забирает в себя абзац, который пользователь печатает уже после выхода
 * из него (BEHAVIOR MVP §4). Вложенные пустые пункты этой болезнью не страдают
 * — штатная команда дедентит их на уровень выше, оставляя настоящий ListItem,
 * и это поведение сохраняется как есть (§4.1, «не менять по вкусу»).
 */
export const listNewline: StateCommand = (target) => {
  const { state } = target;
  const { main } = state.selection;
  if (!main.empty) return continueMarkup(target);

  const line = state.doc.lineAt(main.head);
  if (main.head !== line.to) return continueMarkup(target);

  const match = EMPTY_LIST_ITEM_LINE.exec(line.text);
  if (!match) return continueMarkup(target);
  if (!cursorInsideListItem(state, main.head)) return continueMarkup(target);
  if (depthOf(match[1] ?? '') > 0) return continueMarkup(target);

  // Пустой пункт верхнего уровня — настоящий выход из списка одной транзакцией.
  const { changes, cursor } = collapseLineToBlankBoundary(state, line);
  target.dispatch(
    state.update({
      changes,
      selection: { anchor: cursor },
      userEvent: 'delete.dedent',
      scrollIntoView: true,
    }),
  );
  return true;
};

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
