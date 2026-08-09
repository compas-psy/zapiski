/**
 * Автоформатирование при вводе — таблица из BEHAVIOR §2.1.
 *
 * | Ввод                | Результат                     |
 * | `- `                | маркированный список          | ← markdown как есть
 * | `1. `               | нумерованный список           | ← markdown как есть
 * | `- [ ] ` или `[] `  | чекбокс                       | ← здесь: `[] ` → `- [ ] `
 * | `# ` … `###### `    | заголовок уровня              | ← markdown как есть
 * | `> `                | цитата                        | ← markdown как есть
 * | ```` ```язык ```` + Enter | код-блок с подсветкой   | ← здесь
 * | `---` + Enter       | разделитель                   | ← здесь
 * | `#` + буква         | автодополнение тегов          | ← completion/tags.ts
 * | `[[`                | автодополнение заметок        | ← completion/wiki.ts
 *
 * Строки, которые markdown и так понимает, ничего не переписывают: их
 * «автоформатирование» — это мгновенный live-preview, а не подмена текста.
 * Меньше магии в буфере — меньше сюрпризов при отмене.
 */

import { EditorView } from '@codemirror/view';
import type { Command } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/** `[]` в начале строки (возможно, уже после маркера списка). */
const CHECKBOX_SHORTCUT = /^([\t ]*)((?:[-*+]|\d+[.)])[\t ]+)?\[\]$/;
/** Открывающая линия код-блока. */
const FENCE = /^([\t ]*)(```|~~~)([^`~]*)$/;
/** Разделитель. */
const DIVIDER = /^[\t ]*(-{3,}|\*{3,}|_{3,})[\t ]*$/;

/**
 * `[] ` → `- [ ] `. Пробел — последний символ триггера, поэтому ловим его в
 * `inputHandler` до того, как он попадёт в документ.
 */
export const checkboxShortcut: Extension = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (text !== ' ') return false;
    const line = view.state.doc.lineAt(from);
    const before = line.text.slice(0, from - line.from);
    const match = CHECKBOX_SHORTCUT.exec(before);
    if (!match) return false;
    const indent = match[1] ?? '';
    const marker = match[2] ?? '- ';
    const insert = `${indent}${marker}[ ] `;
    view.dispatch({
      changes: { from: line.from, to, insert },
      selection: { anchor: line.from + insert.length },
      userEvent: 'input.autoformat',
      scrollIntoView: true,
    });
    return true;
  },
);

/** Уже ли закрыт код-блок, начинающийся на этой строке. */
function fenceAlreadyClosed(view: EditorView, linePos: number, fence: string): boolean {
  const node = syntaxTree(view.state).resolveInner(linePos, 1);
  for (let cur: typeof node | null = node; cur; cur = cur.parent) {
    if (cur.name !== 'FencedCode') continue;
    const text = view.state.doc.sliceString(cur.from, cur.to);
    const lines = text.split('\n');
    const last = lines[lines.length - 1];
    return lines.length > 1 && last !== undefined && last.trim().startsWith(fence);
  }
  return false;
}

/** ```` ```язык ```` + Enter → пустая строка внутри блока и закрывающий забор. */
export const completeFencedCode: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const line = view.state.doc.lineAt(range.head);
  if (range.head !== line.to) return false;
  const match = FENCE.exec(line.text);
  if (!match) return false;
  const indent = match[1] ?? '';
  const fence = match[2] ?? '```';
  if (fenceAlreadyClosed(view, line.from, fence)) return false;

  const insert = `\n${indent}\n${indent}${fence}`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + 1 + indent.length },
    userEvent: 'input.autoformat',
    scrollIntoView: true,
  });
  return true;
};

/**
 * `---` + Enter → разделитель.
 *
 * Тонкость CommonMark: `---` сразу под абзацем — это setext-заголовок, а не
 * разделитель. Поэтому при необходимости вставляем пустую строку выше, чтобы
 * пользователь получил ровно то, что ожидал увидеть.
 */
export const completeDivider: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(range.head);
  if (range.head !== line.to) return false;
  if (!DIVIDER.test(line.text)) return false;

  const prev = line.number > 1 ? doc.line(line.number - 1) : null;
  const needsBlank = prev !== null && prev.text.trim().length > 0;
  const changes = needsBlank
    ? [
        { from: line.from, insert: '\n' },
        { from: line.to, insert: '\n' },
      ]
    : [{ from: line.to, insert: '\n' }];

  const anchor = line.to + (needsBlank ? 1 : 0) + 1;
  view.dispatch({
    changes,
    selection: { anchor },
    userEvent: 'input.autoformat',
    scrollIntoView: true,
  });
  return true;
};

export const autoformat: Extension = [checkboxShortcut];
