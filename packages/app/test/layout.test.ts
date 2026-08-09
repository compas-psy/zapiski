/**
 * Каркас и адаптив — SCREENS «Каркас»: брейкпоинты 600 / 900 / 1200 и четыре
 * раскладки; виртуализация списка — BEHAVIOR §1.3.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { layoutFor } from '../src/state/context.js';
import {
  ROW_HEIGHT,
  ROW_HEIGHT_COMPACT,
  VIRTUALIZE_FROM,
  useVirtualWindow,
} from '../src/lib/virtual.js';
import { buildSections, flatten, selectNotes, sortNotes } from '../src/lib/list.js';
import { strings } from '../src/i18n/index.js';
import type { NoteMeta } from '@zapiski/core';

describe('раскладки по брейкпоинтам', () => {
  it('<600 — mobile, 600–900 — compact, 900–1200 — dual, ≥1200 — triple', () => {
    expect(layoutFor(390)).toBe('mobile');
    expect(layoutFor(599)).toBe('mobile');
    expect(layoutFor(600)).toBe('compact');
    expect(layoutFor(899)).toBe('compact');
    expect(layoutFor(900)).toBe('dual');
    expect(layoutFor(1199)).toBe('dual');
    expect(layoutFor(1200)).toBe('triple');
    expect(layoutFor(1920)).toBe('triple');
  });
});

describe('виртуализация — BEHAVIOR §1.3', () => {
  it('включается только после 100 элементов', () => {
    const small = renderHook(() => useVirtualWindow(VIRTUALIZE_FROM, ROW_HEIGHT));
    expect(small.result.current.active).toBe(false);
    expect(small.result.current.end).toBe(VIRTUALIZE_FROM);

    const large = renderHook(() => useVirtualWindow(VIRTUALIZE_FROM + 1, ROW_HEIGHT));
    expect(large.result.current.active).toBe(true);
    expect(large.result.current.end).toBeLessThan(VIRTUALIZE_FROM + 1);
  });

  it('высота строки фиксирована для режима плотности — скроллбар без измерений', () => {
    expect(ROW_HEIGHT).toBe(74);
    expect(ROW_HEIGHT_COMPACT).toBe(58);
    const { result } = renderHook(() => useVirtualWindow(10_000, ROW_HEIGHT));
    const { padTop, padBottom, start, end } = result.current;
    expect(padTop + (end - start) * ROW_HEIGHT + padBottom).toBe(10_000 * ROW_HEIGHT);
  });
});

function note(patch: Partial<NoteMeta>): NoteMeta {
  return {
    id: patch.path ?? 'n',
    path: 'Заметка.md',
    title: 'Заметка',
    snippet: '',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    tags: [],
    encrypted: false,
    hasImage: false,
    hasFile: false,
    hasTodo: false,
    hasLink: false,
    wordCount: 0,
    ...patch,
  };
}

describe('секции списка — BEHAVIOR §1.2', () => {
  const catalog = strings('ru');
  const august2026 = Date.UTC(2026, 7, 9);
  const august2025 = Date.UTC(2025, 7, 9);

  it('«ЗАКРЕПЛЁННЫЕ» всегда сверху, дальше — месяцы', () => {
    const notes = [
      note({ path: 'a.md', updatedAt: august2026, title: 'Обычная' }),
      note({ path: 'b.md', updatedAt: august2025, title: 'Старая' }),
      note({ path: 'c.md', updatedAt: august2026, pinned: true, title: 'Важная' }),
    ];
    const sections = buildSections(notes, 'updated', catalog, august2026);
    expect(sections[0]?.label).toBe('ЗАКРЕПЛЁННЫЕ');
    expect(sections[1]?.label).toBe('АВГУСТ');
    /* Прошлый год подписывается годом (дословный пример из ТЗ). */
    expect(sections[2]?.label).toBe('АВГУСТ 2025');
  });

  it('плоский список чередует подписи секций и строки', () => {
    const items = flatten(
      buildSections([note({ path: 'a.md', updatedAt: august2026 })], 'updated', catalog, august2026),
    );
    expect(items[0]).toMatchObject({ kind: 'section' });
    expect(items[1]).toMatchObject({ kind: 'note' });
  });

  it('архивные не попадают в обычный список, вложенные теги — попадают', () => {
    const notes = [
      note({ path: 'a.md', archived: true }),
      note({ path: 'b.md', tags: ['практика/супервизия'] }),
    ];
    expect(selectNotes(notes, { scope: 'all', folder: null, tag: null })).toHaveLength(1);
    expect(selectNotes(notes, { scope: 'all', folder: null, tag: 'практика' })).toHaveLength(1);
    expect(selectNotes(notes, { scope: 'archive', folder: null, tag: null })).toHaveLength(1);
  });

  it('сортировка по заголовку не рвётся месяцами', () => {
    const notes = [
      note({ path: 'b.md', title: 'Бета', updatedAt: august2026 }),
      note({ path: 'a.md', title: 'Альфа', updatedAt: august2025 }),
    ];
    const sections = buildSections(notes, 'title', catalog, august2026);
    expect(sections).toHaveLength(1);
    expect(sortNotes(notes, 'title').map((item) => item.title)).toEqual(['Альфа', 'Бета']);
  });
});
