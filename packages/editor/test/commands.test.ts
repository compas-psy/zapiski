/**
 * Команды форматирования и хоткеи (BEHAVIOR §7, §2.7).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  cycleHeading,
  insertCodeBlock,
  insertLink,
  insertTable,
  insertWikiLink,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleTaskList,
} from '../src/commands/formatting.js';
import { editorCommands } from '../src/commands/keymap.js';
import { toggleRawMode, rawModeField } from '../src/live-preview/raw-mode.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function open(doc: string, anchor: number, head?: number): EditorView {
  view = makeView(doc, { selection: { anchor, ...(head === undefined ? {} : { head }) } });
  return view;
}

describe('парные маркеры', () => {
  it('Ctrl+B оборачивает выделение', () => {
    const v = open('жирный текст', 0, 6);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('**жирный** текст');
  });

  it('повторный Ctrl+B снимает обёртку', () => {
    const v = open('**жирный** текст', 2, 8);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('жирный текст');
  });

  it('без выделения вставляет пару и ставит курсор между маркерами', () => {
    const v = open('', 0);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe('**');
    expect(v.state.selection.main.head).toBe(1);
  });

  it('Ctrl+U даёт ==подсветку==, а не подчёркивание', () => {
    const v = open('важно', 0, 5);
    toggleHighlight(v);
    expect(v.state.doc.toString()).toBe('==важно==');
  });
});

describe('заголовки', () => {
  it('Ctrl+1..6 ставят нужный уровень', () => {
    for (let level = 1; level <= 6; level++) {
      const v = open('Заголовок', 3);
      setHeading(level)(v);
      expect(v.state.doc.toString()).toBe(`${'#'.repeat(level)} Заголовок`);
      v.destroy();
      view = null;
    }
  });

  it('Ctrl+0 возвращает обычный абзац', () => {
    const v = open('### Заголовок', 5);
    setHeading(0)(v);
    expect(v.state.doc.toString()).toBe('Заголовок');
  });

  it('повторный Ctrl+2 снимает заголовок', () => {
    const v = open('## Заголовок', 5);
    setHeading(2)(v);
    expect(v.state.doc.toString()).toBe('Заголовок');
  });

  it('«H» в тулбаре крутит H1 → H2 → H3 → обычный', () => {
    const v = open('Текст', 2);
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('# Текст');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('## Текст');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('### Текст');
    cycleHeading(v);
    expect(v.state.doc.toString()).toBe('Текст');
  });
});

describe('блочные команды', () => {
  it('маркированный и нумерованный списки', () => {
    const v = open('один\nдва', 0, 8);
    toggleBulletList(v);
    expect(v.state.doc.toString()).toBe('- один\n- два');
    v.dispatch({ selection: EditorSelection.single(0, v.state.doc.length) });
    toggleOrderedList(v);
    expect(v.state.doc.toString()).toBe('1. один\n2. два');
  });

  it('чекбоксы и цитата', () => {
    const v = open('дело', 0, 4);
    toggleTaskList(v);
    expect(v.state.doc.toString()).toBe('- [ ] дело');
    const q = makeView('мысль', { selection: { anchor: 0, head: 5 } });
    toggleQuote(q);
    expect(q.state.doc.toString()).toBe('> мысль');
    q.destroy();
  });

  it('код-блок оборачивает выделение', () => {
    const v = open('let a = 1;', 0, 10);
    insertCodeBlock(v);
    expect(v.state.doc.toString()).toBe('```\nlet a = 1;\n```');
  });

  it('код-блок без выделения ставит курсор внутрь', () => {
    const v = open('', 0);
    insertCodeBlock(v);
    expect(v.state.doc.toString()).toBe('```\n\n```');
    expect(v.state.selection.main.head).toBe(4);
  });
});

describe('вставки ссылок и таблиц', () => {
  it('Ctrl+L оборачивает выделение и ставит курсор в url', () => {
    const v = open('текст', 0, 5);
    insertLink(v);
    expect(v.state.doc.toString()).toBe('[текст]()');
    expect(v.state.selection.main.head).toBe(8);
  });

  it('Ctrl+Shift+W вставляет wiki-ссылку с курсором внутри', () => {
    const v = open('', 0);
    insertWikiLink(v);
    expect(v.state.doc.toString()).toBe('[[]]');
    expect(v.state.selection.main.head).toBe(2);
  });

  it('таблица вставляется с шапкой и разделителем', () => {
    const v = open('', 0);
    insertTable(v);
    const lines = v.state.doc.toString().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain('---');
  });
});

describe('карта хоткеев', () => {
  it('покрывает все хоткеи редактора из BEHAVIOR §7', () => {
    const keys = new Set(editorCommands.map((c) => c.key));
    for (const key of [
      'Mod-b',
      'Mod-i',
      'Mod-u',
      'Mod-1',
      'Mod-2',
      'Mod-3',
      'Mod-4',
      'Mod-5',
      'Mod-6',
      'Mod-0',
      'Mod-Shift-l',
      'Mod-Shift-o',
      'Mod-Shift-k',
      'Mod-Shift-q',
      'Mod-Shift-c',
      'Mod-l',
      'Mod-Shift-w',
      'Mod-d',
      'Alt-ArrowUp',
      'Alt-ArrowDown',
      'Mod-Enter',
      'Mod-f',
      'Mod-h',
      'Mod-e',
      'Mod-Shift-f',
    ]) {
      expect(keys, `нет хоткея ${key}`).toContain(key);
    }
  });

  it('идентификаторы команд уникальны — палитра строится из этого списка', () => {
    const ids = editorCommands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Ctrl+E переключает raw-режим', () => {
    const v = open('# Заголовок', 0);
    expect(v.state.field(rawModeField)).toBe(false);
    toggleRawMode(v);
    expect(v.state.field(rawModeField)).toBe(true);
    toggleRawMode(v);
    expect(v.state.field(rawModeField)).toBe(false);
  });
});

/**
 * Начертания на ссылке (снимок веб-версии).
 *
 * Заказчик: «вот так выглядит ссылка, но её нельзя обернуть жирным или
 * курсивом или жирным курсивом». И правда: пара маркеров падала в середину
 * подписи — `[Вот**** так выглядит ссылка](адрес)`.
 */
describe('жирный и курсив на ссылке', () => {
  const LINK = '[подпись](https://example.org)';

  it('курсор внутри ссылки оборачивает её целиком', () => {
    const v = open(LINK, 3);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(`**${LINK}**`);
  });

  it('повторное нажатие снимает', () => {
    const v = open(`**${LINK}**`, 5);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe(LINK);
  });

  it('курсив ведёт себя так же', () => {
    const v = open(LINK, 3);
    toggleItalic(v);
    expect(v.state.doc.toString()).toBe(`*${LINK}*`);
  });

  it('вне ссылки поведение прежнее: пара маркеров под курсором', () => {
    const v = open('обычный текст', 3);
    toggleBold(v);
    expect(v.state.doc.toString()).toBe('обы****чный текст');
  });
});
