/**
 * Цвет маркера списка работает и в режиме «Разметка».
 *
 * ── Что сказал заказчик ─────────────────────────────────────────────────────
 *
 * «В настройках стоит, что маркер списка должен быть акцентным по цвету, но он
 * то ли приглушённый, то ли как текст».
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Класс `cm-z-list-mark`, к которому привязан цвет из настроек, вешал только
 * живой предпросмотр. В режиме «Разметка» предпросмотр отдаёт пустой набор
 * декораций целиком — и маркер оставался на подсветке синтаксиса, где он
 * помечен общим тегом со всеми служебными знаками, то есть третичным серым.
 * Настройку можно было переключать сколько угодно, ничего не менялось.
 *
 * Проверка идёт через настоящее представление (`EditorView` в jsdom): поле
 * состояния «разметка» переключается эффектом, и увидеть результат можно
 * только на живом наборе декораций, а не на голом состоянии.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { zapiskiEditor } from '../src/setup.js';
import { noopRuntime } from '../src/runtime.js';
import { setRawMode } from '../src/live-preview/raw-mode.js';

const DOC = '- первый пункт\n- второй пункт\n';

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function open(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({ doc, extensions: zapiskiEditor({ runtime: noopRuntime }) }),
    parent,
  });
  return view;
}

/** Сколько маркеров покрашено «своим» классом — тем, что читает настройку. */
function tinted(target: EditorView): number {
  return target.dom.querySelectorAll('.cm-z-list-mark').length;
}

describe('маркер списка красится', () => {
  it('в живом предпросмотре', () => {
    const editor = open(DOC);
    expect(tinted(editor)).toBeGreaterThan(0);
  });

  it('и в режиме «Разметка» — настройка про оформление, а не про предпросмотр', () => {
    const editor = open(DOC);
    editor.dispatch({ effects: setRawMode.of(true) });
    expect(
      tinted(editor),
      'в режиме разметки маркер снова серый: цвет из настроек не применяется',
    ).toBeGreaterThan(0);
  });

  it('и возвращается к предпросмотру без задвоения класса', () => {
    const editor = open(DOC);
    editor.dispatch({ effects: setRawMode.of(true) });
    const raw = tinted(editor);
    editor.dispatch({ effects: setRawMode.of(false) });
    expect(tinted(editor)).toBe(raw);
  });

  it('нумерованный список тоже: номер несёт смысл', () => {
    const editor = open('1. первый\n2. второй\n');
    editor.dispatch({ effects: setRawMode.of(true) });
    expect(tinted(editor)).toBeGreaterThan(0);
  });
});
