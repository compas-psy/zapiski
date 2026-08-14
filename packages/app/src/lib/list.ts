/**
 * Отбор, сортировка и секции списка заметок — BEHAVIOR §1.2.
 *
 * Порядок: «Закреплённые» всегда сверху (ручной порядок, по умолчанию — по
 * дате изменения), затем группы по месяцам по дате изменения.
 */
import type { NoteMeta } from '@zapiski/core';
import type { Strings } from '../i18n/index.js';
import { monthKey, monthSection } from './format.js';
import type { ListScope, SortMode } from '../state/store.js';

export interface ListFilter {
  scope: ListScope;
  folder: string | null;
  tag: string | null;
  /**
   * Показывать ли заметки из ВЛОЖЕННЫХ папок вместе с содержимым открытой.
   *
   * По умолчанию нет, и это перемена. Раньше папка показывала и своё, и всё,
   * что лежит глубже, без единого признака — заказчик: «непонятно, находятся
   * ли заметки в корневой папке, которая открыта, или в подпапке». Хуже того,
   * из этого рождался призрак второго дефекта: перенёс заметку в подпапку, а
   * она осталась на месте — «после перетаскивания копия остаётся в старой
   * папке». Копии нет и не было: заметка одна, просто родитель продолжал её
   * показывать.
   *
   * Умолчание «только эта папка» — то, как ведут себя проводник, Finder и
   * файловые панели: открыл папку — видишь её содержимое. Кому нужен прежний
   * порядок, включает его в настройках, и тогда у каждой чужой заметки
   * появляется подпись, из какой она подпапки.
   */
  includeSubfolders?: boolean;
}

export function selectNotes(notes: readonly NoteMeta[], filter: ListFilter): NoteMeta[] {
  return notes.filter((note) => {
    if (filter.scope === 'archive') {
      if (!note.archived) return false;
    } else if (note.archived) {
      return false;
    }
    if (filter.scope === 'pinned' && !note.pinned) return false;
    if (filter.folder !== null) {
      const dir = note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '';
      const inside = filter.includeSubfolders === true && dir.startsWith(`${filter.folder}/`);
      if (dir !== filter.folder && !inside) return false;
    }
    if (filter.tag !== null) {
      /* Вложенные теги: `практика` показывает и `практика/супервизия`. */
      const match = note.tags.some(
        (tag) => tag === filter.tag || tag.startsWith(`${filter.tag}/`),
      );
      if (!match) return false;
    }
    return true;
  });
}

export function sortNotes(notes: readonly NoteMeta[], mode: SortMode): NoteMeta[] {
  const copy = [...notes];
  switch (mode) {
    case 'created':
      return copy.sort((a, b) => b.createdAt - a.createdAt);
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    case 'manual':
      return copy.sort((a, b) => (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER));
    case 'updated':
    default:
      return copy.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export interface ListSection {
  key: string;
  label: string;
  notes: NoteMeta[];
}

/** Плоский элемент — то, что реально рендерится и виртуализируется. */
export type ListItem =
  | { kind: 'section'; key: string; label: string }
  | { kind: 'note'; key: string; note: NoteMeta };

export function buildSections(
  notes: readonly NoteMeta[],
  mode: SortMode,
  strings: Strings,
  now = Date.now(),
): ListSection[] {
  const pinned = sortNotes(
    notes.filter((note) => note.pinned),
    mode === 'manual' ? 'manual' : mode,
  );
  const rest = sortNotes(
    notes.filter((note) => !note.pinned),
    mode,
  );

  const sections: ListSection[] = [];
  if (pinned.length > 0) {
    sections.push({ key: 'pinned', label: strings.list.pinnedSection, notes: pinned });
  }

  /* По заголовку сортируем без месяцев — иначе алфавит рвётся секциями. */
  if (mode === 'title' || mode === 'manual') {
    if (rest.length > 0) sections.push({ key: 'all', label: '', notes: rest });
    return sections;
  }

  const stamp = (note: NoteMeta): number => (mode === 'created' ? note.createdAt : note.updatedAt);
  let current: ListSection | null = null;
  for (const note of rest) {
    const key = monthKey(stamp(note));
    if (!current || current.key !== key) {
      current = { key, label: monthSection(stamp(note), strings, now), notes: [] };
      sections.push(current);
    }
    current.notes.push(note);
  }
  return sections;
}

export function flatten(sections: readonly ListSection[]): ListItem[] {
  const items: ListItem[] = [];
  for (const section of sections) {
    if (section.label !== '') {
      items.push({ kind: 'section', key: `s:${section.key}`, label: section.label });
    }
    for (const note of section.notes) items.push({ kind: 'note', key: note.path, note });
  }
  return items;
}
