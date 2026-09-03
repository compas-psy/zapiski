/**
 * P1-аудит: четыре обработчика ввода не проверяли, что строка под курсором
 * лежит внутри уже открытого блока кода, и переинтерпретировали содержимое
 * код-блока как настоящую разметку — `checkboxShortcut`, `setextGuard`,
 * `completeDivider`, `enterAtBlockStart`. Код — единственное место, где
 * содержимое НИКОГДА не переинтерпретируется (BEHAVIOR §2.1): внутри кода
 * `[]`, одиночный `-`, `---` и `# ...` — буквальный текст, а не разметка.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';

import { completeDivider } from '../src/input/autoformat.js';
import { enterAtBlockStart } from '../src/input/block-start.js';
import { setEditorMode } from '../src/live-preview/editor-mode.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/**
 * Зовёт зарегистрированные `inputHandler`-расширения ТОЙ ЖЕ сигнатурой, что
 * использует сам CodeMirror при реальной DOM-мутации. `view.dispatch()`
 * напрямую эту цепочку не проходит вовсе — см. `ime.test.ts`.
 */
function fireInputHandler(target: EditorView, from: number, to: number, text: string): boolean {
  const handlers = target.state.facet(EditorView.inputHandler);
  const defaultInsert = (): ReturnType<EditorView['state']['update']> =>
    target.state.update({ changes: { from, to, insert: text } });
  return handlers.some((handler) => handler(target, from, to, text, defaultInsert));
}

describe('checkboxShortcut не срабатывает внутри код-блока', () => {
  it('«[]» + пробел в примере кода остаётся буквальным текстом', () => {
    const doc = '```js\nconst empty =\n[]\n```';
    const pos = doc.indexOf('[]') + 2;
    view = makeView(doc, { selection: { anchor: pos } });

    const handled = fireInputHandler(view, pos, pos, ' ');

    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('setextGuard не срабатывает внутри код-блока', () => {
  it('одиночный «-» в код-блоке не вставляет пустую строку', () => {
    const doc = '```yaml\nkey: value\n\n```';
    const pos = doc.indexOf('\n\n') + 1;
    view = makeView(doc, { selection: { anchor: pos } });

    const handled = fireInputHandler(view, pos, pos, '-');

    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('completeDivider не срабатывает внутри код-блока', () => {
  it('строка «---» внутри код-блока не превращается в разделитель', () => {
    const doc = '```\ncode above\n---\ncode below\n```';
    const dividerLine = doc.split('\n')[2] as string;
    const pos = doc.indexOf(dividerLine) + dividerLine.length;
    view = makeView(doc, { selection: { anchor: pos } });

    const handled = completeDivider(view);

    expect(handled).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe('enterAtBlockStart не срабатывает внутри код-блока', () => {
  it('«# fake» внутри код-блока в простом режиме не считается началом заголовка', () => {
    const doc = '```\n# fake\n```';
    const pos = doc.indexOf('# fake') + 2; // сразу после «# », будто это заголовок
    view = makeView(doc, { selection: { anchor: pos } });
    view.dispatch({ effects: setEditorMode.of('simple') });

    let dispatched = false;
    const ok = enterAtBlockStart({
      state: view.state,
      dispatch: () => {
        dispatched = true;
      },
    });

    expect(ok).toBe(false);
    expect(dispatched).toBe(false);
  });
});
