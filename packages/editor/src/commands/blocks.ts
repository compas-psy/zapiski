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

import { splitLine, toggleWrap } from './formatting.js';

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

/**
 * Мелкий текст — 13 px, для сносок и подписей.
 *
 * С выделением оборачивается ИМЕННО ВЫДЕЛЕННОЕ. Дефект, ради которого это
 * дописано: заказчик выделил один символ в строке `22**2=8`, а получил
 * `<small>22*2=8</small>` — мелким становилась вся строка целиком, что бы он
 * ни выделил. Команда просто не смотрела на выделение и всегда работала со
 * строкой.
 *
 * Без выделения работа по строке остаётся: «сделать эту подпись мелкой» —
 * нормальное намерение, и требовать для него выделения незачем.
 */
export const insertSmall: StateCommand = (target) => {
  const { state, dispatch } = target;
  if (!state.selection.main.empty) return toggleWrap('<small>', '</small>')(target);

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

/**
 * Автор цитаты (замечание 4).
 *
 * В файле это остаётся markdown: ещё одна строка цитаты, начинающаяся с
 * тире, — `> — Автор`. Так пишут атрибуцию от руки, и так она читается в
 * любом редакторе, который про наши договорённости не знает.
 *
 * Если автора не вписали, никакой строки не появляется: пустая атрибуция не
 * должна занимать место в просмотре — это прямое требование заказчика.
 * Поэтому команда добавляет строку, а показ прячет её, пока в ней нет ничего
 * кроме тире (см. `decorations.ts`).
 */
export const insertQuoteAuthor: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  /* Работает только внутри цитаты: автор без цитаты — просто тире в тексте. */
  if (!/^\s*>/.test(line.text)) return false;
  /* Уже есть строка автора — ставим курсор в неё, а не плодим вторую. */
  const AUTHOR = /^\s*>\s*—/;
  if (AUTHOR.test(line.text)) {
    dispatch(state.update({ selection: { anchor: line.to }, scrollIntoView: true }));
    return true;
  }

  const indent = line.text.slice(0, line.text.length - line.text.trimStart().length);
  const insert = `\n${indent}> — `;
  dispatch(
    state.update({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};
