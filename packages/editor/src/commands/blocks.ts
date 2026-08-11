/**
 * Блоки, которых требует меню «Стиль абзаца» (ITERATION-1 §4): выноска,
 * мелкий текст и сворачиваемый блок.
 *
 * Все три остаются обычным markdown-текстом в файле — это условие «file over
 * app»: заметка обязана открываться чужим редактором так же осмысленно.
 * Выноска — цитата с меткой `[!note]` (соглашение, знакомое по Obsidian и
 * GitHub), мелкий текст и сворачиваемый блок — html-теги, которые markdown
 * пропускает как есть.
 */
import type { StateCommand } from '@codemirror/state';

import { splitLine } from './formatting.js';

/**
 * Выноска — крупная врезка внутри текста.
 *
 * Повторный вызов снимает её, возвращая обычный абзац: пункт меню помечен
 * галочкой, и нажатие на помеченный пункт обязано снимать стиль, а не
 * добавлять вторую метку.
 */
export const insertCallout: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const marked = /^>\s*\[![^\]]*\]\s?/.exec(line.text.trimStart());
  const indent = line.text.slice(0, line.text.length - line.text.trimStart().length);

  const next = marked
    ? `${indent}${line.text.trimStart().slice(marked[0].length)}`
    : `${indent}> [!note] ${stripQuote(line.text.trimStart())}`;
  if (next === line.text) return false;

  dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert: next },
      selection: { anchor: line.from + next.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** Мелкий текст — 13 px, для сносок и подписей. */
export const insertSmall: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const marked = /^\s*<small>([\s\S]*?)<\/small>\s*$/.exec(line.text);
  const next = marked ? (marked[1] as string) : `<small>${line.text}</small>`;
  if (next === line.text) return false;

  dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert: next },
      selection: { anchor: line.from + next.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/**
 * Сворачиваемый блок: заголовок со стрелкой и скрытым содержимым.
 *
 * В файле сохраняется как `<details><summary>` — так его понимают и GitHub, и
 * Obsidian, и любой браузер, если заметку просто открыть.
 */
export const insertCollapsible: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const { rest } = splitLine(line.text);
  const summary = rest.trim();
  const insert = `<details>\n<summary>${summary}</summary>\n\n`;
  const tail = '\n</details>';

  dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert: `${insert}${tail}` },
      /* Курсор — в пустую строку между открытием и закрытием: писать человек
         будет там, а не в подписи, которую он уже набрал. */
      selection: { anchor: line.from + insert.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** Снимает маркер цитаты, если он был: `> текст` → `текст`. */
function stripQuote(text: string): string {
  return text.replace(/^>\s?/, '');
}
