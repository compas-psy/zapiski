/**
 * Автоформатирование при вводе и работа со списками (BEHAVIOR §2.1).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { completeDivider, completeFencedCode } from '../src/input/autoformat.js';
import {
  dedentListItem,
  indentListItem,
  listBackspace,
  listNewline,
  MAX_LIST_DEPTH,
} from '../src/input/lists.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Прогнать StateCommand по состоянию и вернуть новый документ. */
function runState(
  state: EditorState,
  command: (target: {
    state: EditorState;
    dispatch: (tr: ReturnType<EditorState['update']>) => void;
  }) => boolean,
): { doc: string; ok: boolean; state: EditorState } {
  let next = state;
  const ok = command({ state, dispatch: (tr) => (next = tr.state) });
  return { doc: next.doc.toString(), ok, state: next };
}

function stateOf(doc: string, anchor: number): EditorState {
  const v = makeView(doc, { selection: { anchor } });
  const state = v.state;
  v.destroy();
  return state;
}

describe('автоформатирование при вводе', () => {
  it('`[] ` в начале строки превращается в чекбокс', () => {
    view = makeView('[]', { selection: { anchor: 2 } });
    // inputHandler ловит пробел до попадания в документ.
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view as EditorView, 2, 2, ' ', () => null as never));
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe('- [ ] ');
  });

  it('`- [] ` тоже превращается в чекбокс, маркер сохраняется', () => {
    view = makeView('- []', { selection: { anchor: 4 } });
    view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view as EditorView, 4, 4, ' ', () => null as never));
    expect(view.state.doc.toString()).toBe('- [ ] ');
  });

  it('вложенный `[] ` сохраняет отступ', () => {
    view = makeView('  - []', { selection: { anchor: 6 } });
    view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view as EditorView, 6, 6, ' ', () => null as never));
    expect(view.state.doc.toString()).toBe('  - [ ] ');
  });

  it('```язык + Enter достраивает код-блок и ставит курсор внутрь', () => {
    view = makeView('```js', { selection: { anchor: 5 } });
    expect(completeFencedCode(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('```js\n\n```');
    expect(view.state.selection.main.head).toBe(6);
  });

  it('повторный Enter в уже закрытом блоке ничего не достраивает', () => {
    view = makeView('```js\nlet a = 1;\n```', { selection: { anchor: 5 } });
    expect(completeFencedCode(view)).toBe(false);
  });

  it('--- + Enter даёт разделитель, а не setext-заголовок', () => {
    view = makeView('Абзац\n---', { selection: { anchor: 9 } });
    expect(completeDivider(view)).toBe(true);
    // Пустая строка выше — иначе CommonMark считает это заголовком H2.
    expect(view.state.doc.toString()).toBe('Абзац\n\n---\n');
  });

  it('--- после пустой строки просто переносит курсор', () => {
    view = makeView('Абзац\n\n---', { selection: { anchor: 10 } });
    expect(completeDivider(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('Абзац\n\n---\n');
  });
});

describe('Enter, Tab и Backspace в списках', () => {
  it('Enter создаёт следующий элемент того же типа', () => {
    const { doc } = runState(stateOf('- первый', 8), listNewline);
    expect(doc).toBe('- первый\n- ');
  });

  it('Enter в нумерованном списке продолжает нумерацию', () => {
    const { doc } = runState(stateOf('1. первый', 9), listNewline);
    expect(doc).toBe('1. первый\n2. ');
  });

  it('Enter в списке задач создаёт новый чекбокс', () => {
    const { doc } = runState(stateOf('- [ ] задача', 12), listNewline);
    expect(doc).toContain('- [ ] ');
    expect(doc.split('\n').length).toBe(2);
  });

  it('Enter на пустом элементе выходит из списка', () => {
    const { doc } = runState(stateOf('- первый\n- ', 11), listNewline);
    expect(doc.endsWith('- ')).toBe(false);
  });

  it('Tab увеличивает вложенность', () => {
    const { doc, ok } = runState(stateOf('- пункт', 3), indentListItem);
    expect(ok).toBe(true);
    expect(doc).toBe('  - пункт');
  });

  it('вложенность ограничена шестью уровнями', () => {
    let state = stateOf(`${'  '.repeat(MAX_LIST_DEPTH - 1)}- глубоко`, 2);
    const result = runState(state, indentListItem);
    expect(result.ok).toBe(false);
    state = stateOf(`${'  '.repeat(MAX_LIST_DEPTH - 2)}- почти`, 2);
    expect(runState(state, indentListItem).ok).toBe(true);
  });

  it('Shift+Tab уменьшает вложенность', () => {
    const { doc, ok } = runState(stateOf('    - пункт', 6), dedentListItem);
    expect(ok).toBe(true);
    expect(doc).toBe('  - пункт');
  });

  it('Tab вне списка не срабатывает — фокус уходит дальше', () => {
    expect(runState(stateOf('обычный абзац', 3), indentListItem).ok).toBe(false);
  });

  it('Backspace в начале элемента снимает маркер, не удаляя строку', () => {
    const state = stateOf('- пункт', 2);
    const { doc } = runState(state, listBackspace);
    expect(doc).toBe('pпункт'.replace('p', ''));
    expect(doc).toBe('пункт');
  });

  it('несколько выделенных строк сдвигаются одной командой', () => {
    const base = stateOf('- один\n- два', 0);
    const withSelection = base.update({
      selection: EditorSelection.single(0, base.doc.length),
    }).state;
    const { doc } = runState(withSelection, indentListItem);
    expect(doc).toBe('  - один\n  - два');
  });
});
