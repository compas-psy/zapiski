/**
 * Курсор в начале блока и место под картинкой.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * «Если в редакторе в простом режиме поставлю курсор перед первой буквой,
 * например, Заголовка1 и нажму Enter, то каретка перенесётся вместе со строкой
 * вниз, но и форматирование потеряется. Это происходит потому, что "#" остался
 * выше, а пользователь этого не видит».
 *
 * И вторым пунктом: «когда вставил картинку, перевести каретку под неё можно
 * только нажав Enter на строке выше».
 *
 * Обе жалобы — про одно: в простом режиме разметка спрятана, поэтому «начало
 * строки» и «конец заметки» на экране не там, где в тексте.
 */
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { caretAtTail, enterAtBlockStart } from '../src/input/block-start.js';
import { editorMode, setEditorMode, type EditorMode } from '../src/live-preview/editor-mode.js';

function stateWith(doc: string, at: number, mode: EditorMode = 'simple'): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(at),
    extensions: [editorMode],
  });
  return state.update({ effects: setEditorMode.of(mode) }).state;
}

/** Выполнить команду и вернуть получившееся состояние. */
function run(state: EditorState, command: StateCommand): { ok: boolean; state: EditorState } {
  let next = state;
  const ok = command({
    state,
    dispatch: (transaction) => {
      next = transaction.state;
    },
  });
  return { ok, state: next };
}

describe('Enter перед первой буквой заголовка', () => {
  it('заголовок остаётся заголовком, пустая строка встаёт сверху', () => {
    /* Курсор ровно там, где на экране начинается текст: после спрятанной `# `. */
    const { ok, state } = run(stateWith('# Заголовок1\nтекст\n', 2), enterAtBlockStart);

    expect(ok).toBe(true);
    expect(state.doc.toString()).toBe('\n# Заголовок1\nтекст\n');
    /* Курсор уехал вместе со своим заголовком. */
    expect(state.selection.main.head).toBe(3);
  });

  it('то же с цитатой', () => {
    const { ok, state } = run(stateWith('> мысль\n', 2), enterAtBlockStart);
    expect(ok).toBe(true);
    expect(state.doc.toString()).toBe('\n> мысль\n');
  });

  it('внутри текста Enter остаётся обычным', () => {
    /* Курсор в середине слова — делить строку здесь правильно, и командой это
       не наше дело. */
    const { ok } = run(stateWith('# Заголовок1\n', 6), enterAtBlockStart);
    expect(ok).toBe(false);
  });

  it('в профессиональном режиме — обычное поведение', () => {
    /* Там решётка видна, и человек сам видит, где стоит курсор. */
    const { ok } = run(stateWith('# Заголовок1\n', 2, 'pro'), enterAtBlockStart);
    expect(ok).toBe(false);
  });

  it('обычная строка не трогается', () => {
    const { ok } = run(stateWith('просто текст\n', 0), enterAtBlockStart);
    expect(ok).toBe(false);
  });

  it('список остаётся за своей командой', () => {
    /* У списков Enter свой — новый пункт и выход на пустом (`input/lists.ts`).
       Две команды на одну клавишу спорили бы за один и тот же случай. */
    const { ok } = run(stateWith('- пункт\n', 2), enterAtBlockStart);
    expect(ok).toBe(false);
  });
});

describe('место под последней строкой', () => {
  it('под картинкой заводится строка, и курсор встаёт в неё', () => {
    /* Картинка рисуется виджетом, разметка строки скрыта: ткнуть под ней
       некуда, а если она последняя — писать дальше нечем. */
    const state = stateWith('![](Images/схема.png)', 0);
    const result = run(state, caretAtTail);

    expect(result.ok).toBe(true);
    expect(result.state.doc.toString()).toBe('![](Images/схема.png)\n');
    expect(result.state.selection.main.head).toBe(result.state.doc.length);
  });

  it('пустая последняя строка не плодит новых', () => {
    const state = stateWith('текст\n', 0);
    const first = run(state, caretAtTail);
    expect(first.ok).toBe(true);
    expect(first.state.doc.toString()).toBe('текст\n');

    /* Второе нажатие в то же место ничего не меняет: курсор уже там. */
    const second = run(first.state, caretAtTail);
    expect(second.ok).toBe(false);
  });
});
