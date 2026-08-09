/**
 * Режим фокуса, типографика, автосохранение и панель поиска.
 * (BEHAVIOR §2.8, §10, §0, §4)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { focusModeField, setFocusMode, toggleFocusMode, exitFocusMode } from '../src/focus/focus-mode.js';
import { typographyStyle, defaultTypography } from '../src/typography.js';
import { AUTOSAVE_DEBOUNCE_MS, flushAutosave } from '../src/save/autosave.js';
import { matchStats, openFind, openReplace } from '../src/search/panel.js';
import { getSearchQuery, setSearchQuery, SearchQuery } from '@codemirror/search';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
});

function decoClasses(target: EditorView): string[] {
  const out: string[] = [];
  for (const set of target.state.facet(EditorView.decorations)) {
    const value = typeof set === 'function' ? set(target) : set;
    const iter = value.iter();
    while (iter.value) {
      const spec = iter.value.spec as { class?: string };
      if (spec.class) out.push(spec.class);
      iter.next();
    }
  }
  return out;
}

describe('режим фокуса (BEHAVIOR §2.8)', () => {
  const doc = 'Первый абзац\nпродолжение\n\nВторой абзац\n\nТретий абзац';

  it('выключен по умолчанию — декораций затемнения нет', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    expect(decoClasses(v).some((c) => c.includes('cm-z-focus'))).toBe(false);
  });

  it('активный абзац остаётся ярким, остальные затемняются', () => {
    const v = makeView(doc, { selection: { anchor: 2 } });
    view = v;
    toggleFocusMode(v);
    const classes = decoClasses(v);
    expect(classes.filter((c) => c === 'cm-z-focus-active').length).toBe(2);
    expect(classes.filter((c) => c === 'cm-z-focus-dim').length).toBeGreaterThan(0);
  });

  it('Esc выходит из фокуса, а вне фокуса ничего не перехватывает', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    expect(exitFocusMode(v)).toBe(false);
    toggleFocusMode(v);
    expect(exitFocusMode(v)).toBe(true);
    expect(v.state.field(focusModeField).enabled).toBe(false);
  });

  it('typewriter-скролл выключен по умолчанию', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    expect(v.state.field(focusModeField).typewriter).toBe(false);
    v.dispatch({ effects: setFocusMode.of({ typewriter: true }) });
    expect(v.state.field(focusModeField).typewriter).toBe(true);
  });

  it('подсказка «фокус · Esc — выйти» появляется и исчезает', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    expect(v.dom.querySelector('.cm-z-focus-hint')).toBeNull();
    toggleFocusMode(v);
    expect(v.dom.querySelector('.cm-z-focus-hint')?.textContent).toContain('Esc');
    toggleFocusMode(v);
    expect(v.dom.querySelector('.cm-z-focus-hint')).toBeNull();
  });
});

describe('типографика (DESIGN_TOKENS §2)', () => {
  it('умолчания — 16 / 1.65 / колонка 640 / sans', () => {
    const style = typographyStyle(defaultTypography);
    expect(style).toContain('--z-fs: 16.00px');
    expect(style).toContain('--z-lh: 1.650');
    expect(style).toContain('--z-col: 640px');
  });

  it('пять ступеней кегля дают пять разных значений', () => {
    const sizes = ([14, 15, 16, 18, 20] as const).map(
      (size) => typographyStyle({ ...defaultTypography, size }).match(/--z-fs: ([\d.]+)px/)?.[1],
    );
    expect(new Set(sizes).size).toBe(5);
  });

  it('компактный режим уменьшает кегль, интерлиньяж и поля', () => {
    const normal = typographyStyle(defaultTypography);
    const compact = typographyStyle({ ...defaultTypography, compact: true });
    expect(compact).toContain('--z-fs: 14.50px');
    expect(compact).not.toBe(normal);
    expect(compact).toContain('--z-pad-y: 24px');
  });

  it('вся ширина отключает ограничение колонки', () => {
    expect(typographyStyle({ ...defaultTypography, column: 'full' })).toContain('--z-col: none');
  });

  it('serif переключает семейство и добавляет шаг кегля', () => {
    const serif = typographyStyle({ ...defaultTypography, family: 'serif' });
    expect(serif).toContain('--font-serif');
    expect(serif).toContain('--z-fs: 17.00px');
  });

  it('в стилях нет ни одного hex-значения', () => {
    for (const settings of [
      defaultTypography,
      { ...defaultTypography, family: 'serif' as const, compact: true },
    ]) {
      expect(typographyStyle(settings)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe('автосохранение (BEHAVIOR §0)', () => {
  it('сохраняет через 500 мс после последнего кейстрока', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const v = makeView('текст', { selection: { anchor: 5 }, runtime: { save } });
    view = v;
    v.dispatch({ changes: { from: 5, insert: '!' } });
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledWith('текст!');
  });

  it('серия кейстроков даёт одно сохранение', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const v = makeView('', { selection: { anchor: 0 }, runtime: { save } });
    view = v;
    for (const ch of 'слово') {
      const at = v.state.doc.length;
      v.dispatch({ changes: { from: at, insert: ch } });
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('слово');
  });

  it('blur сохраняет немедленно', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const v = makeView('текст', { selection: { anchor: 5 }, runtime: { save } });
    view = v;
    v.dispatch({ changes: { from: 5, insert: '?' } });
    v.contentDOM.dispatchEvent(new Event('blur', { bubbles: true }));
    expect(save).toHaveBeenCalledWith('текст?');
  });

  it('flushAutosave сохраняет по требованию и не дублирует', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const v = makeView('текст', { selection: { anchor: 5 }, runtime: { save } });
    view = v;
    v.dispatch({ changes: { from: 5, insert: '.' } });
    flushAutosave(v);
    flushAutosave(v);
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('без изменений ничего не сохраняется', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const v = makeView('текст', { selection: { anchor: 0 }, runtime: { save } });
    view = v;
    v.dispatch({ selection: { anchor: 3 } });
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('поиск в заметке (BEHAVIOR §4)', () => {
  const doc = 'кот кот кот и ещё кот';

  it('счётчик «N из M» считает все совпадения', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    openFind(v);
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'кот', literal: true })) });
    expect(matchStats(v).total).toBe(4);
  });

  it('текущее совпадение считается от позиции курсора', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    openFind(v);
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: 'кот', literal: true })) });
    v.dispatch({ selection: { anchor: 8 } });
    expect(matchStats(v).current).toBe(3);
  });

  it('панель поиска открывается и рисует своё поле', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    openFind(v);
    expect(v.dom.querySelector('.cm-z-find')).not.toBeNull();
    expect(v.dom.querySelector('.cm-z-find input')).not.toBeNull();
  });

  it('Ctrl+H показывает поле замены', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    openReplace(v);
    const inputs = v.dom.querySelectorAll<HTMLInputElement>('.cm-z-find input');
    expect(inputs.length).toBe(2);
    expect(inputs[1]?.style.display).toBe('');
  });

  it('пустой запрос — ноль совпадений', () => {
    const v = makeView(doc, { selection: { anchor: 0 } });
    view = v;
    openFind(v);
    expect(getSearchQuery(v.state).valid).toBe(false);
    expect(matchStats(v)).toEqual({ current: 0, total: 0 });
  });
});
