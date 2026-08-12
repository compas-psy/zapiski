/**
 * Палитра команд — SCREENS §10b (`4g`), BEHAVIOR §7.
 *
 * Fuzzy-поиск по командам, заметкам (без префикса), папкам (`/`), тегам (`#`)
 * и настройкам (`>`). До 8 результатов, стрелки + Enter, Esc — закрыть,
 * хоткей показывается рядом с командой.
 *
 * Приёмочный критерий №8 («все хоткеи §7 работают и отражены в палитре»)
 * выполняется строением, а не дисциплиной: команды текста берутся из
 * `editorCommands` пакета `@zapiski/editor` — это тот же массив, из которого
 * собран keymap редактора. Копии списка здесь нет: появится новая команда в
 * редакторе — она сама появится в палитре с правильным хоткеем.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { editorCommands, rankByFuzzy, type EditorCommandSpec } from '@zapiski/editor';
import { Modal } from '@zapiski/ui';
import type { SettingsSection } from '../contract.js';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { activeEditor } from '../state/active-editor.js';
import type { Strings } from '../i18n/index.js';

/** Сколько строк показывает палитра (BEHAVIOR §7). */
const LIMIT = 8;
/** Последние использованные команды — сверху при пустом запросе (BEHAVIOR §7). */
const RECENT_LIMIT = 3;

interface Entry {
  id: string;
  group: string;
  label: string;
  hotkey?: string;
  run: () => void;
}

/**
 * Хоткеи оболочки. Команд текста здесь нет: их ключи живут в `editorCommands`.
 * `view.focus` и `view.raw` — исключение: переключает их оболочка (от этого
 * зависит хром экрана), но ключ всё равно читается из списка редактора.
 */
export const SHELL_HOTKEYS: Record<string, string> = {
  'app.newNote': 'Ctrl+N',
  'app.newNoteHere': 'Ctrl+Shift+N',
  /* Оба сочетания, как в таблице §7: `Ctrl+P` работал, но в палитре не
     показывался, а критерий §13.8 требует, чтобы хоткеи были в ней отражены. */
  'app.palette': 'Ctrl+K / Ctrl+P',
  'app.globalSearch': 'Ctrl+Shift+S',
  'app.toggleLibrary': 'Ctrl+\\',
  'app.settings': 'Ctrl+,',
  'app.exportNote': 'Ctrl+Shift+E',
  'app.togglePin': 'Ctrl+Shift+P',
  'app.quickNote': 'Ctrl+Alt+N',
};

/** Команды текста, которыми владеет оболочка, а не CodeMirror. */
const SHELL_OWNED = new Set(['view.focus', 'view.raw']);

/** Подписи команд редактора по id из `editorCommands`. */
function editorCommandLabel(id: string, strings: Strings): string | null {
  const c = strings.commands;
  const heading = /^format\.h([1-6])$/.exec(id);
  if (heading) return c.heading(Number(heading[1]));
  switch (id) {
    case 'format.bold':
      return c.bold;
    case 'format.italic':
      return c.italic;
    case 'format.highlight':
      return c.highlight;
    case 'format.strike':
      return c.strike;
    case 'format.paragraph':
      return c.paragraph;
    case 'format.bulletList':
      return c.bulletList;
    case 'format.orderedList':
      return c.orderedList;
    case 'format.task':
      return c.checkbox;
    case 'format.quote':
      return c.quote;
    case 'format.codeBlock':
      return c.codeBlock;
    case 'insert.link':
      return c.link;
    case 'insert.wikiLink':
      return c.wikiLink;
    case 'line.duplicate':
      return c.duplicateLine;
    case 'line.moveUp':
      return c.moveLineUp;
    case 'line.moveDown':
      return c.moveLineDown;
    case 'task.toggle':
      return c.toggleTask;
    case 'note.find':
      return c.findInNote;
    case 'note.replace':
      return c.replaceInNote;
    case 'view.raw':
      return c.toggleRaw;
    case 'view.focus':
      return c.focusMode;
    case 'paste.plain':
      return c.pastePlain;
    default:
      /* Новая команда редактора без подписи показывается по id, а не прячется:
         иначе критерий №8 тихо переставал бы выполняться. */
      return null;
  }
}

/** `Mod-Shift-l` → `Ctrl+Shift+L`; `Alt-ArrowUp` → `Alt+↑`. */
export function displayHotkey(key: string): string {
  return key
    .split('-')
    .map((part) => {
      if (part === 'Mod') return 'Ctrl';
      if (part === 'ArrowUp') return '↑';
      if (part === 'ArrowDown') return '↓';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join('+');
}

/** Хоткей команды редактора по её id — единственный источник, копий нет. */
export function editorHotkey(id: string): string | undefined {
  const spec = editorCommands.find((item: EditorCommandSpec) => item.id === id);
  return spec ? displayHotkey(spec.key) : undefined;
}

/** Последние использованные команды. Живут сессию — на диск не пишутся. */
const recent: string[] = [];

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
    const group = strings.palette.groups.commands;
    const path = state.route.name === 'note' ? state.route.id : null;
    const note = path ? state.notes.find((item) => item.path === path) : undefined;

    const shell: Entry[] = [
      { id: 'app.newNote', group, label: strings.commands.newNote, run: () => void app.createNote() },
      {
        id: 'app.newNoteHere',
        group,
        label: strings.commands.newNoteHere,
        run: () => void app.createNote(state.folder ?? undefined),
      },
      { id: 'app.palette', group, label: strings.commands.palette, run: () => app.togglePalette(true) },
      {
        id: 'app.globalSearch',
        group,
        label: strings.commands.globalSearch,
        run: () => app.navigate({ name: 'search' }),
      },
      { id: 'app.toggleLibrary', group, label: strings.commands.toggleLibrary, run: () => app.toggleLibrary() },
      { id: 'app.settings', group, label: strings.commands.settings, run: () => app.openSettings() },
      { id: 'app.help', group, label: strings.help.open, run: () => app.navigate({ name: 'help' }) },
      {
        id: 'app.togglePin',
        group,
        label: strings.commands.togglePin,
        run: () => {
          if (note) void app.setPinned(note.path, !note.pinned);
        },
      },
      {
        id: 'app.exportNote',
        group,
        label: strings.commands.exportNote,
        run: () => app.navigate({ name: 'settings', section: 'transfer' }),
      },
    ];

    /* Возможности платформы нет → элемент СКРЫТ, а не выключен (ARCHITECTURE §2). */
    if (app.host.platform.globalHotkey) {
      shell.push({
        id: 'app.quickNote',
        group,
        label: strings.commands.quickNote,
        run: () => void app.createNote(),
      });
    }

    for (const entry of shell) {
      const hotkey = SHELL_HOTKEYS[entry.id];
      if (hotkey) entry.hotkey = hotkey;
    }

    /* Переключатели вида принадлежат оболочке, но ключ — из списка редактора. */
    const view: Entry[] = [
      { id: 'view.focus', group, label: strings.commands.focusMode, run: () => app.toggleFocusMode() },
      { id: 'view.raw', group, label: strings.commands.toggleRaw, run: () => app.toggleRawMode() },
    ];
    for (const entry of view) {
      const hotkey = editorHotkey(entry.id);
      if (hotkey) entry.hotkey = hotkey;
    }

    /* Команды текста — ровно `editorCommands`, без копии списка. */
    const text: Entry[] =
      path === null
        ? []
        : editorCommands
            .filter((spec) => !SHELL_OWNED.has(spec.id))
            .map((spec) => ({
              id: spec.id,
              group,
              label: editorCommandLabel(spec.id, strings) ?? spec.id,
              hotkey: displayHotkey(spec.key),
              run: () => {
                const view = activeEditor()?.view;
                if (view) spec.run?.(view);
              },
            }));

    return [...shell, ...view, ...text];
  }, [app, state.route, state.notes, state.folder, strings]);

  const entries = useMemo<Entry[]>(() => {
    if (query.startsWith('#')) {
      return state.tags
        .filter((item) => item.tag.includes(query.slice(1)))
        .slice(0, LIMIT)
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
        .slice(0, LIMIT)
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
        .filter((item) =>
          strings.settings.sections[item].toLowerCase().includes(query.slice(1).toLowerCase()),
        )
        .slice(0, LIMIT)
        .map((item) => ({
          id: `settings:${item}`,
          group: strings.palette.groups.settings,
          label: strings.settings.sections[item],
          run: () => app.openSettings(item),
        }));
    }

    const trimmed = query.trim();
    if (trimmed === '') {
      /* Пустой запрос: последние три использованные — сверху (BEHAVIOR §7). */
      const mru = recent
        .map((id) => commands.find((item) => item.id === id))
        .filter((item): item is Entry => item !== undefined);
      const rest = commands.filter((item) => !recent.includes(item.id));
      return [...mru, ...rest].slice(0, LIMIT);
    }

    const matchedCommands = rankByFuzzy(commands, trimmed, (item) => item.label, LIMIT);
    const matchedNotes = rankByFuzzy(
      state.notes.filter((item) => !item.archived),
      trimmed,
      (item) => item.title,
      LIMIT,
    ).map((item) => ({
      id: `note:${item.path}`,
      group: strings.palette.groups.notes,
      label: item.title || strings.notes.untitled,
      run: () => app.openNote(item.path),
    }));
    return [...matchedCommands, ...matchedNotes];
  }, [app, commands, query, state.folders, state.notes, state.tags, strings]);

  const close = (): void => app.togglePalette(false);

  const choose = (entry: Entry | undefined): void => {
    if (!entry) return;
    if (entry.id.includes('.')) {
      const index = recent.indexOf(entry.id);
      if (index >= 0) recent.splice(index, 1);
      recent.unshift(entry.id);
      recent.splice(RECENT_LIMIT);
    }
    /* Команда текста работает над представлением: сначала закрываем палитру,
       иначе фокус остаётся в поле и `EditorView` не видит выделения. */
    close();
    entry.run();
  };

  /* Заголовок группы рисуется перед первой её строкой. */
  let lastGroup = '';

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
            choose(entries[cursor]);
          } else if (event.key === 'Escape') {
            close();
          }
        }}
      />

      <div className="za-palette__list" role="listbox" aria-label={strings.palette.label}>
        {entries.length === 0 ? (
          <p className="za-muted">{strings.palette.empty}</p>
        ) : (
          entries.map((entry, index) => {
            const groupLabel = entry.group === lastGroup ? null : entry.group;
            lastGroup = entry.group;
            return (
              <div key={entry.id}>
                {groupLabel ? <p className="za-section">{groupLabel}</p> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  className={`za-palette__item${index === cursor ? ' za-palette__item--active' : ''}`}
                  onClick={() => choose(entry)}
                >
                  {entry.label}
                  {entry.hotkey ? <span className="za-palette__hotkey">{entry.hotkey}</span> : null}
                </button>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
