/**
 * Палитра команд — SCREENS §10b (`4g`), BEHAVIOR §7.
 *
 * Fuzzy-поиск по командам, заметкам (без префикса), папкам (`/`), тегам (`#`)
 * и настройкам (`>`). До 8 результатов, стрелки + Enter, Esc — закрыть,
 * хоткей показывается рядом с командой (приёмочный критерий №8: все хоткеи
 * §7 отражены здесь).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rankByFuzzy } from '@zapiski/editor';
import { Modal } from '@zapiski/ui';
import type { SettingsSection } from '../contract.js';
import { useApp, useAppState, useStrings } from '../state/context.js';

interface Entry {
  id: string;
  group: string;
  label: string;
  hotkey?: string;
  run: () => void;
}

/** Хоткеи оболочки (BEHAVIOR §7) — команды текста живут в редакторе. */
const SHELL_HOTKEYS: Record<string, string> = {
  'app.newNote': 'Ctrl+N',
  'app.newNoteHere': 'Ctrl+Shift+N',
  'app.palette': 'Ctrl+K',
  'app.focusMode': 'Ctrl+Shift+F',
  'app.globalSearch': 'Ctrl+Shift+S',
  'app.toggleRaw': 'Ctrl+E',
  'app.toggleLibrary': 'Ctrl+\\',
  'app.settings': 'Ctrl+,',
  'app.exportNote': 'Ctrl+Shift+E',
  'app.togglePin': 'Ctrl+Shift+P',
  'app.findInNote': 'Ctrl+F',
  'app.replaceInNote': 'Ctrl+H',
  'app.quickNote': 'Ctrl+Alt+N',
};

export function CommandPalette(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.paletteOpen) {
      setQuery('');
      setCursor(0);
      /* Поле 15.5 с курсором — фокус сразу при открытии. */
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [state.paletteOpen]);

  const commands = useMemo<Entry[]>(() => {
    const path = state.route.name === 'note' ? state.route.id : null;
    const note = path ? state.notes.find((item) => item.path === path) : undefined;
    const list: Entry[] = [
      { id: 'app.newNote', group: strings.palette.groups.commands, label: strings.commands.newNote, run: () => void app.createNote() },
      {
        id: 'app.newNoteHere',
        group: strings.palette.groups.commands,
        label: strings.commands.newNoteHere,
        run: () => void app.createNote(state.folder ?? undefined),
      },
      { id: 'app.globalSearch', group: strings.palette.groups.commands, label: strings.commands.globalSearch, run: () => app.navigate({ name: 'search' }) },
      { id: 'app.focusMode', group: strings.palette.groups.commands, label: strings.commands.focusMode, run: () => app.toggleFocusMode() },
      { id: 'app.toggleRaw', group: strings.palette.groups.commands, label: strings.commands.toggleRaw, run: () => app.toggleRawMode() },
      { id: 'app.toggleLibrary', group: strings.palette.groups.commands, label: strings.commands.toggleLibrary, run: () => app.toggleLibrary() },
      { id: 'app.settings', group: strings.palette.groups.commands, label: strings.commands.settings, run: () => app.openSettings() },
      {
        id: 'app.togglePin',
        group: strings.palette.groups.commands,
        label: strings.commands.togglePin,
        run: () => {
          if (note) void app.setPinned(note.path, !note.pinned);
        },
      },
      {
        id: 'app.exportNote',
        group: strings.palette.groups.commands,
        label: strings.commands.exportNote,
        run: () => app.navigate({ name: 'settings', section: 'transfer' }),
      },
    ];
    for (const [id, hotkey] of Object.entries(SHELL_HOTKEYS)) {
      const entry = list.find((item) => item.id === id);
      if (entry) entry.hotkey = hotkey;
    }
    return list;
  }, [app, state.route, state.notes, state.folder, strings]);

  const entries = useMemo<Entry[]>(() => {
    if (query.startsWith('#')) {
      return state.tags
        .filter((item) => item.tag.includes(query.slice(1)))
        .slice(0, 8)
        .map((item) => ({
          id: `tag:${item.tag}`,
          group: strings.palette.groups.tags,
          label: `#${item.tag}`,
          run: () => app.openTag(item.tag),
        }));
    }
    if (query.startsWith('/')) {
      return state.folders
        .filter((item) => item.path.includes(query.slice(1)))
        .slice(0, 8)
        .map((item) => ({
          id: `folder:${item.path}`,
          group: strings.palette.groups.folders,
          label: item.path,
          run: () => app.openFolder(item.path),
        }));
    }
    if (query.startsWith('>')) {
      const sections: SettingsSection[] = [
        'appearance',
        'editor',
        'sync',
        'security',
        'transfer',
        'storage',
        'account',
        'plus',
      ];
      return sections
        .filter((item) => strings.settings.sections[item].toLowerCase().includes(query.slice(1).toLowerCase()))
        .slice(0, 8)
        .map((item) => ({
          id: `settings:${item}`,
          group: strings.palette.groups.settings,
          label: strings.settings.sections[item],
          run: () => app.openSettings(item),
        }));
    }

    const trimmed = query.trim();
    /* Пустой запрос — сначала команды (последние использованные сверху). */
    const matchedCommands =
      trimmed === ''
        ? commands.slice(0, 8)
        : rankByFuzzy(commands, trimmed, (item) => item.label).slice(0, 8);
    const matchedNotes =
      trimmed === ''
        ? []
        : rankByFuzzy(
            state.notes.filter((item) => !item.archived),
            trimmed,
            (item) => item.title,
          )
            .slice(0, 8)
            .map((item) => ({
              id: `note:${item.path}`,
              group: strings.palette.groups.notes,
              label: item.title || strings.notes.untitled,
              run: () => app.openNote(item.path),
            }));
    return [...matchedCommands, ...matchedNotes];
  }, [app, commands, query, state.folders, state.notes, state.tags, strings]);

  const close = (): void => app.togglePalette(false);

  return (
    <Modal
      open={state.paletteOpen}
      onClose={close}
      wide
      label={strings.palette.label}
      footer={<span className="za-palette__footer">{strings.palette.footer}</span>}
    >
      <input
        ref={inputRef}
        className="za-palette__input"
        value={query}
        aria-label={strings.palette.label}
        placeholder={strings.palette.placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setCursor(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setCursor((value) => Math.min(entries.length - 1, value + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor((value) => Math.max(0, value - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            entries[cursor]?.run();
            close();
          } else if (event.key === 'Escape') {
            close();
          }
        }}
      />

      <div className="za-palette__list" role="listbox" aria-label={strings.palette.label}>
        {entries.length === 0 ? (
          <p className="za-muted">{strings.palette.empty}</p>
        ) : (
          entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === cursor}
              className={`za-palette__item${index === cursor ? ' za-palette__item--active' : ''}`}
              onClick={() => {
                entry.run();
                close();
              }}
            >
              {entry.label}
              {entry.hotkey ? <span className="za-palette__hotkey">{entry.hotkey}</span> : null}
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
