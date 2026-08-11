/**
 * Два режима редактора (ITERATION-1 §8).
 *
 * Приёмочный критерий сформулирован жёстко: «в простом режиме ни один символ
 * разметки не виден ни в одном состоянии, включая курсор внутри узла». Это и
 * проверяется — именно «включая курсор», потому что обычный взгляд на экран
 * дефекта не поймает: снаружи узла разметка схлопнута в обоих режимах, и
 * разница видна ровно в тот момент, когда человек ставит курсор в слово.
 *
 * Второе требование того же §8 — смена режима не меняет файл. Режим только
 * способ показа: заметка, набранная в простом, обязана открываться в чужом
 * редакторе тем же markdown.
 */
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { zapiskiEditor } from '../src/setup.js';
import { editorModeOf, setEditorMode, type EditorMode } from '../src/live-preview/editor-mode.js';

/** Редактор с текстом и режимом; курсор ставится отдельно. */
function makeView(doc: string, mode: EditorMode): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: zapiskiEditor({ mode }) }),
    parent,
  });
  view.dispatch({ effects: setEditorMode.of(mode) });
  return view;
}

/** Видимый текст редактора — то, что человек читает глазами. */
function visible(view: EditorView): string {
  return view.contentDOM.textContent ?? '';
}

/** Ставит курсор внутрь первого вхождения подстроки. */
function cursorInside(view: EditorView, needle: string): void {
  const at = view.state.doc.toString().indexOf(needle);
  view.dispatch({ selection: EditorSelection.cursor(at + Math.ceil(needle.length / 2)) });
}

describe('простой режим: разметки не видно никогда', () => {
  /* У каждого текста есть первая строка без разметки: курсор по умолчанию
     стоит в позиции 0, и без неё «вне узла» оказалось бы внутри — заголовок и
     цитата начинаются с самого начала документа. */
  for (const [name, doc, needle, marks] of [
    ['жирный', 'начало\n\nэто **важное** слово', 'важное', '**'],
    ['курсив', 'начало\n\nэто *косое* слово', 'косое', '*'],
    ['заголовок', 'начало\n\n## Раздел', 'Раздел', '#'],
    ['цитата', 'начало\n\n> мысль', 'мысль', '>'],
    ['подсветка', 'начало\n\nэто ==яркое== слово', 'яркое', '=='],
    ['зачёркнутый', 'начало\n\nэто ~~убрано~~ слово', 'убрано', '~~'],
  ] as const) {
    it(`${name}: символы не появляются даже под курсором`, () => {
      const view = makeView(doc, 'simple');
      expect(visible(view), 'вне узла').not.toContain(marks);

      cursorInside(view, needle);
      expect(visible(view), 'курсор внутри узла').not.toContain(marks);
      /* Сам текст при этом на месте — прячется разметка, а не содержимое. */
      expect(visible(view)).toContain(needle);
      view.destroy();
    });
  }
});

describe('профессиональный режим: разметка проявляется у курсора', () => {
  it('вне узла схлопнута, внутри — видна', () => {
    const view = makeView('начало\n\nэто **важное** слово', 'pro');
    expect(visible(view), 'вне узла').not.toContain('**');

    cursorInside(view, 'важное');
    expect(visible(view), 'курсор внутри узла').toContain('**');
    view.destroy();
  });
});

describe('режим не меняет файл', () => {
  it('переключение туда и обратно оставляет текст нетронутым', () => {
    /* Ключевое свойство §8: режим — способ показа, а не формат хранения. */
    const doc = '# Заголовок\n\nэто **важное** слово\n\n- [ ] дело\n';
    const view = makeView(doc, 'simple');

    view.dispatch({ effects: setEditorMode.of('pro') });
    expect(view.state.doc.toString()).toBe(doc);

    view.dispatch({ effects: setEditorMode.of('simple') });
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  it('переключение сохраняет позицию курсора', () => {
    const view = makeView('это **важное** слово', 'simple');
    cursorInside(view, 'важное');
    const before = view.state.selection.main.head;

    view.dispatch({ effects: setEditorMode.of('pro') });
    expect(view.state.selection.main.head).toBe(before);
    view.destroy();
  });
});

describe('умолчание', () => {
  it('библиотека по умолчанию ведёт себя по-прежнему', () => {
    /* Профессиональный — прежнее поведение редактора. Продуктовое умолчание
       «простой для новых людей» задаёт приложение своими настройками: решать
       за всех, кто подключит редактор, библиотека не вправе. */
    const state = EditorState.create({ doc: 'текст', extensions: zapiskiEditor({}) });
    expect(editorModeOf(state)).toBe('pro');
  });

  it('без поля вовсе — тоже профессиональный', () => {
    expect(editorModeOf(EditorState.create({ doc: 'текст' }))).toBe('pro');
  });
});
