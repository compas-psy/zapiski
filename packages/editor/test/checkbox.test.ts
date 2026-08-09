/**
 * Чекбоксы (BEHAVIOR §2.3, SCREENS §4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { toggleTaskAt, toggleTaskAtCursor } from '../src/live-preview/interactions.js';
import { TaskBoxWidget } from '../src/live-preview/widgets.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

describe('переключение чекбокса', () => {
  it('снятый становится отмеченным и наоборот', () => {
    const v = makeView('- [ ] задача', { selection: { anchor: 0 } });
    view = v;
    expect(toggleTaskAt(v, 8)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [x] задача');
    toggleTaskAt(v, 8);
    expect(v.state.doc.toString()).toBe('- [ ] задача');
  });

  it('замена символ-в-символ: длина документа не меняется', () => {
    const v = makeView('- [ ] задача\n- [ ] вторая', { selection: { anchor: 0 } });
    view = v;
    const before = v.state.doc.length;
    toggleTaskAt(v, 3);
    expect(v.state.doc.length).toBe(before);
  });

  it('отмеченные не перемещаются автоматически', () => {
    const v = makeView('- [ ] раз\n- [ ] два\n- [ ] три', { selection: { anchor: 0 } });
    view = v;
    toggleTaskAt(v, 3);
    expect(v.state.doc.toString().split('\n')[0]).toBe('- [x] раз');
    expect(v.state.doc.toString().split('\n')[2]).toBe('- [ ] три');
  });

  it('вызывает лёгкую хэптику', () => {
    const haptic = vi.fn();
    const v = makeView('- [ ] задача', { selection: { anchor: 0 }, runtime: { haptic } });
    view = v;
    toggleTaskAt(v, 3);
    expect(haptic).toHaveBeenCalledWith('light');
  });

  it('на строке без задачи ничего не делает', () => {
    const v = makeView('обычный текст', { selection: { anchor: 3 } });
    view = v;
    expect(toggleTaskAt(v, 3)).toBe(false);
    expect(v.state.doc.toString()).toBe('обычный текст');
  });

  it('Ctrl+Enter отмечает чекбокс на строке курсора', () => {
    const v = makeView('- [ ] раз\n- [ ] два', { selection: { anchor: 14 } });
    view = v;
    expect(toggleTaskAtCursor(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- [ ] раз\n- [x] два');
  });

  it('работает и в нумерованном списке задач', () => {
    const v = makeView('1. [ ] пункт', { selection: { anchor: 0 } });
    view = v;
    expect(toggleTaskAt(v, 3)).toBe(true);
    expect(v.state.doc.toString()).toBe('1. [x] пункт');
  });

  it('тап по тексту задачи курсор не переключает — обработчик его не ловит', () => {
    const v = makeView('- [ ] задача', { selection: { anchor: 0 } });
    view = v;
    // Событие приходит с contentDOM, а не с квадрата: обработчик пропускает.
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    v.contentDOM.dispatchEvent(event);
    expect(v.state.doc.toString()).toBe('- [ ] задача');
  });
});

describe('виджет квадрата', () => {
  it('рисует rect и галочку, различает состояния', () => {
    const off = new TaskBoxWidget(false).toDOM();
    const on = new TaskBoxWidget(true).toDOM();
    expect(off.className).toBe('cm-z-taskbox');
    expect(on.className).toContain('cm-z-taskbox-checked');
    expect(off.querySelector('rect')).not.toBeNull();
    expect(off.querySelector('path')).not.toBeNull();
  });

  it('одинаковые состояния считаются равными — анимация не переигрывается', () => {
    expect(new TaskBoxWidget(true).eq(new TaskBoxWidget(true))).toBe(true);
    expect(new TaskBoxWidget(true).eq(new TaskBoxWidget(false))).toBe(false);
  });
});
