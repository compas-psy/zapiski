/**
 * «Переносить выполненные вниз» (ITERATION-1 §3, BEHAVIOR §2.3).
 *
 * По умолчанию отмеченная задача остаётся на месте — это важнее, чем кажется:
 * человек отмечает пункт и глазами держит соседние, а прыжок строки сбивает
 * чтение. Поэтому настройка выключена, и включать её приходится осознанно.
 *
 * Настройка живёт в фасете, а не в опциях сборки редактора: её меняют в
 * настройках, и эффект обязан быть мгновенным, без пересоздания состояния —
 * иначе потеряются история отмены и позиция курсора.
 */
import { Compartment, Facet, type Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export const moveDoneToBottom = Facet.define<boolean, boolean>({
  combine: (values) => values[values.length - 1] ?? false,
});

const compartment = new Compartment();

/** Расширение с начальным значением настройки. */
export function taskOrder(enabled = false): Extension {
  return compartment.of(moveDoneToBottom.of(enabled));
}

/** Применить настройку на лету (BEHAVIOR §10: мгновенно, без «Применить»). */
export function applyTaskOrder(view: EditorView, enabled: boolean): void {
  view.dispatch({ effects: compartment.reconfigure(moveDoneToBottom.of(enabled)) });
}

/** Элемент списка-задачи: маркер списка, затем `[ ]` / `[x]`. */
const TASK_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;

interface Block {
  /** Номера строк подряд идущего списка задач того же уровня отступа. */
  readonly lines: number[];
}

/**
 * Непрерывный блок задач вокруг строки. Границей служит любая строка, не
 * являющаяся задачей того же отступа: чужой список, абзац, пустая строка.
 * Так отмеченный пункт не уезжает в соседний список через весь документ.
 */
function blockAround(state: EditorState, lineNumber: number): Block | null {
  const start = TASK_LINE.exec(state.doc.line(lineNumber).text);
  if (!start) return null;
  const indent = start[1] ?? '';

  const belongs = (n: number): boolean => {
    if (n < 1 || n > state.doc.lines) return false;
    const match = TASK_LINE.exec(state.doc.line(n).text);
    return match !== null && (match[1] ?? '') === indent;
  };

  let first = lineNumber;
  while (belongs(first - 1)) first -= 1;
  let last = lineNumber;
  while (belongs(last + 1)) last += 1;

  const lines: number[] = [];
  for (let n = first; n <= last; n += 1) lines.push(n);
  return { lines };
}

/** Отмечена ли задача на строке. */
function isDone(state: EditorState, lineNumber: number): boolean {
  const match = TASK_LINE.exec(state.doc.line(lineNumber).text);
  return match !== null && (match[2] ?? ' ') !== ' ';
}

/**
 * Переписывает блок задач так, чтобы выполненные оказались снизу, сохраняя
 * порядок внутри каждой группы. Возвращает `null`, если переставлять нечего, —
 * тогда документ не трогается вовсе и в историю отмены ничего не попадает.
 */
export function reorderTasks(
  state: EditorState,
  lineNumber: number,
): { from: number; to: number; insert: string } | null {
  if (!state.facet(moveDoneToBottom)) return null;
  const block = blockAround(state, lineNumber);
  if (!block || block.lines.length < 2) return null;

  const texts = block.lines.map((n) => state.doc.line(n).text);
  const pending = block.lines.filter((n) => !isDone(state, n)).map((n) => state.doc.line(n).text);
  const done = block.lines.filter((n) => isDone(state, n)).map((n) => state.doc.line(n).text);
  const next = [...pending, ...done];
  if (next.every((text, index) => text === texts[index])) return null;

  const first = state.doc.line(block.lines[0] as number);
  const last = state.doc.line(block.lines[block.lines.length - 1] as number);
  return { from: first.from, to: last.to, insert: next.join('\n') };
}
