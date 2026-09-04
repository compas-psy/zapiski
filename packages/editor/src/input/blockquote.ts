/**
 * Enter в цитате — выход на пустой строке верхнего уровня (BEHAVIOR §2.1,
 * тот же принцип, что уже есть у списков в `input/lists.ts`).
 *
 * ── Отказ, ради которого написано (P1-аудит closure-pass, эскалация из
 *    классификации доп. находок: «NOT ACCEPTABLE — RECOMMEND IMMEDIATE
 *    FIX») ────────────────────────────────────────────────────────────────
 *
 * У списка пустой пункт верхнего уровня выходит из списка на ВТОРОМ Enter
 * (первый создаёт пустой пункт, второй — на нём — превращает его в
 * настоящую пустую строку и закрывает список). Человек, которого продукт
 * этому научил, применяет тот же жест к цитате — и получает другое число
 * нажатий: без этого модуля Enter на пустой строке `>` не выходит из
 * цитаты ни на втором нажатии, ни сразу на третьем чисто — сначала
 * добавляет ЕЩЁ одну пустую строку-цитату, и только следующий Enter
 * закрывает блок. Хуже, чем лишнее нажатие: если человек, ожидая
 * поведения списка, набирает текст сразу после ВТОРОГО Enter (как для
 * списка это уже настоящий абзац), текст молча становится НОВЫМ
 * ПРОЦИТИРОВАННЫМ абзацем внутри всё ещё открытой цитаты — не тем блоком,
 * который он думал, что печатает.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState, StateCommand } from '@codemirror/state';
import { collapseLineToBlankBoundary } from '../syntax/block-boundary.js';

/** Пустая строка цитаты ВЕРХНЕГО уровня целиком — маркер и ничего больше. */
const EMPTY_QUOTE_LINE = /^[\t ]*>[\t ]?$/;

/** Курсор действительно разобран парсером как `Blockquote`. */
function cursorInsideBlockquote(state: EditorState, pos: number): boolean {
  for (
    let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'Blockquote') return true;
  }
  return false;
}

/**
 * Enter на пустой строке `>` верхнего уровня — настоящий выход из цитаты
 * одной транзакцией, тем же приёмом, что уже доказан для списков
 * (`collapseLineToBlankBoundary`): стирает маркер до НАСТОЯЩЕЙ пустой
 * строки CommonMark, а не оставляет один `\n`, который следующий текст
 * забрал бы обратно в цитату lazy continuation.
 *
 * Вложенная цитата (`>> `) сюда не подпадает намеренно — `EMPTY_QUOTE_LINE`
 * матчит ровно один уровень; поведение вложенных цитат не менялось и не
 * заявлено как часть этого фикса.
 */
export const blockquoteNewline: StateCommand = (target) => {
  const { state } = target;
  const { main } = state.selection;
  if (!main.empty) return false;

  const line = state.doc.lineAt(main.head);
  if (main.head !== line.to) return false;
  if (!EMPTY_QUOTE_LINE.test(line.text)) return false;
  if (!cursorInsideBlockquote(state, main.head)) return false;

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
