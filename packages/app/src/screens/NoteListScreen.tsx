/**
 * Список заметок — SCREENS §3, BEHAVIOR §1.
 *
 * Здесь собраны: секции «ЗАКРЕПЛЁННЫЕ» + месяцы, свайпы с порогом 96 px,
 * long-press-меню, виртуализация при >100 строк, pull-to-search и
 * pull-to-refresh двумя пальцами, а также все ячейки матрицы §12 для этого
 * экрана.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { isAttachmentDir, type NoteMeta } from '@zapiski/core';
import { Button, Fab, IconButton, IconPlus, IconSearch } from '@zapiski/ui';
import { useApp, useAppState, useLayout, useStrings } from '../state/context.js';
import { IconMenu } from '../components/icons.js';
import { NoteRow } from '../components/NoteRow.js';
import { ContextMenu, type MenuItem } from '../components/ContextMenu.js';
import { SyncIndicator } from '../components/SyncIndicator.js';
import { FolderPickerDialog } from '../components/FolderDialogs.js';
import { AttachmentFolderView } from './AttachmentFolderView.js';
import { EncryptSheet } from './EncryptSheet.js';
import {
  EmptyBlock,
  InlineError,
  ListSkeleton,
  LockedRows,
  Section,
} from '../components/ScreenStates.js';
import { buildSections, flatten, selectNotes } from '../lib/list.js';
import { usePull } from '../lib/gestures.js';
import { ROW_HEIGHT, ROW_HEIGHT_COMPACT, useVirtualWindow } from '../lib/virtual.js';
import type { SortMode } from '../state/store.js';

export interface NoteListScreenProps {
  /** В трёх- и двухпанельной раскладке список — отдельная панель. */
  embedded?: boolean;
  compactRows?: boolean;
}

export function NoteListScreen({ embedded = false, compactRows = false }: NoteListScreenProps): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const layout = useLayout();
  const [menuFor, setMenuFor] = useState<NoteMeta | null>(null);
  /** Какую заметку переносим в другую папку. `null` — диалог закрыт. */
  const [movingNote, setMovingNote] = useState<NoteMeta | null>(null);
  /** Какую заметку шифруем. */
  const [encrypting, setEncrypting] = useState<NoteMeta | null>(null);
  /** Какую заметку выгружаем и в каком формате. */
  const [exporting, setExporting] = useState<NoteMeta | null>(null);

  const [sortMenu, setSortMenu] = useState(false);

  const haptic = app.host.platform.haptics
    ? app.host.platform.haptics.impact.bind(app.host.platform.haptics)
    : undefined;

  /* Заметки из вложенных папок — по настройке (см. `ListFilter`). */
  const includeSubfolders = app.subfolderNotesValue();
  const filter = {
    scope: state.scope,
    folder: state.folder,
    tag: state.tag,
    includeSubfolders,
  };
  const notes = useMemo(
    () => selectNotes(state.notes, filter),
    [state.notes, filter.scope, filter.folder, filter.tag, includeSubfolders],
  );
  const sortMode = app.sortModeFor(state.folder);
  const items = useMemo(
    () => flatten(buildSections(notes, sortMode, strings)),
    [notes, sortMode, strings],
  );

  /*
    Открыта служебная папка вложений — показываем файлы, а не заметки.
    Заказчик: «файлы по факту в папках есть, но они не отображаются
    приложением». Их и не могло быть видно: список умеет только заметки, а
    заметок в `Images`, `Audio` и `Other files` не бывает.
  */
  const attachmentFolder = state.folder !== null && isAttachmentDir(state.folder);

  const screenState = app.screenState(state.folder || state.tag ? 'folder' : 'list', notes.length === 0);
  const rowHeight = compactRows ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;
  const virtual = useVirtualWindow(items.length, rowHeight);

  const pull = usePull({
    onPullToSearch: () => app.navigate({ name: 'search' }),
    onPullToRefresh: () => void app.syncNow(),
    disabled: state.sync.state === 'syncing',
  });

  const title = state.tag
    ? `#${state.tag}`
    : state.folder
      ? state.folder.split('/').pop() ?? strings.list.title
      : strings.list.title;

  const isMobile = layout === 'mobile' || layout === 'compact';

  const body = ((): ReactNode => {
    if (attachmentFolder && screenState !== 'loading') return <AttachmentFolderView />;
    switch (screenState) {
      case 'loading':
        return <ListSkeleton />;
      case 'locked':
        return <LockedRows />;
      case 'empty':
        return (
          <EmptyBlock
            title={state.folder || state.tag ? strings.list.emptyFolderTitle : strings.empty.list}
            {...(state.folder || state.tag ? {} : { description: strings.list.emptyText })}
            action={
              <Button onClick={() => void app.createNote(state.folder ?? undefined)}>
                {strings.list.newNote}
              </Button>
            }
          />
        );
      default:
        return (
          <>
            {/* Ошибка синка — строкой в списке, ввод текста не блокируется. */}
            {screenState === 'error' && state.syncError ? (
              <InlineError message={state.syncError} onRetry={() => void app.syncNow()} />
            ) : null}
            {virtual.padTop > 0 ? <div style={{ blockSize: virtual.padTop }} /> : null}
            {items.slice(virtual.start, virtual.end).map((item) =>
              item.kind === 'section' ? (
                <Section key={item.key}>{item.label}</Section>
              ) : (
                <NoteRow
                  key={item.key}
                  note={item.note}
                  compact={compactRows}
                  selected={state.route.name === 'note' && state.route.id === item.note.path}
                  onOpen={() => app.openNote(item.note.path)}
                  onSwipeRight={() => void app.setPinned(item.note.path, !item.note.pinned)}
                  onSwipeLeft={() => void app.archive(item.note.path, !item.note.archived)}
                  onLongPress={() => setMenuFor(item.note)}
                  haptic={haptic}
                  rightLabel={item.note.pinned ? strings.list.unpin : strings.list.pin}
                  leftLabel={item.note.archived ? strings.list.unarchive : strings.list.archive}
                  /* Заметка из вложенной папки обязана назвать свою папку:
                     иначе непонятно, где она лежит, — с этого и начался
                     разговор про «копию, оставшуюся в старой папке». */
                  {...(subfolderOf(item.note.path, state.folder)
                    ? { folderHint: subfolderOf(item.note.path, state.folder) as string }
                    : {})}
                  /* Тащить можно там, где есть чем: на телефоне мышью не
                     тащат, а через две панели пальцем — тем более. */
                  draggable={!isMobile}
                />
              ),
            )}
            {virtual.padBottom > 0 ? <div style={{ blockSize: virtual.padBottom }} /> : null}
          </>
        );
    }
  })();

  return (
    <div className="za-bottom__host">
      <div className="za-header">
        {isMobile || layout === 'dual' ? (
          <IconButton
            icon={<IconMenu size={22} />}
            label={strings.list.openLibrary}
            tone="ghost"
            onClick={() => app.toggleLibrary(true)}
          />
        ) : null}
        <h1
          className={`za-h1 za-h1--mobile za-header__title${
            embedded ? ' za-header__title--column' : ''
          }`}
        >
          {title}
        </h1>
        {/* Оффлайн — чип-пилюля в шапке, не блокирующий баннер (SCREENS §3). */}
        {screenState === 'offline' ? (
          <span className="za-chip">{strings.errors.offline}</span>
        ) : null}
        <div className="za-header__actions">
          <SyncIndicator />
          {/*
            «+» — создать заметку. На телефоне для этого есть круглая кнопка
            внизу, а на широком экране не было НИЧЕГО: заметка заводилась
            только сочетанием Ctrl+N, о котором надо знать. Заказчик так и
            написал: «нет + ков для добавления папок или заметок».

            Место выбрано по правилу колонки: действие относится к списку,
            значит живёт в его шапке, а не в общей навигации слева.
          */}
          {/* В папке вложений заметку не создаём: она легла бы между
              картинками и мешала бы и здесь, и в списке. */}
          {!isMobile && !attachmentFolder ? (
            <IconButton
              icon={<IconPlus size={18} />}
              label={strings.list.newNote}
              tone="ghost"
              onClick={() => void app.createNote(state.folder ?? undefined)}
            />
          ) : null}
          <IconButton
            icon={<span aria-hidden="true">⋯</span>}
            label={strings.list.sortMenu}
            tone="ghost"
            onClick={() => setSortMenu(true)}
          />
        </div>
      </div>

      {/*
        Поиск на широком экране — постоянное поле вверху колонки списка.

        До этой строки на Windows поиска не было видно вовсе: пилюля рисуется
        только на телефоне (`isMobile` ниже), а с клавиатуры он открывался
        сочетанием, которое надо было знать. Заказчик так и написал: «Windows
        очень не хватает поиска по заметкам».

        Поле настоящее, а не кнопка: набранное сразу уходит в поиск, и человек
        не теряет первые символы. Подпись сочетания — не украшение, а способ
        научить: она показывает, чем открыть поиск, не отрывая рук.

        Условие `!embedded` отсюда снято, и это второй заход на ту же жалобу.
        В трёхпанельной раскладке — а это ровно то, что человек видит на
        Windows в развёрнутом окне, — список показывается «встроенным», и поле
        пряталось. То есть поиск чинили для двухпанельной раскладки, а
        заказчик сидел в трёхпанельной и снова написал: «нет поиска по
        заметкам, хотя в дизайне есть».
      */}
      {!isMobile ? (
        <div className="za-listsearch">
          <IconSearch size={15} />
          <input
            className="za-listsearch__input"
            type="search"
            value={state.query}
            placeholder={strings.list.searchPlaceholder}
            aria-label={strings.search.title}
            onChange={(event) => {
              app.setQuery(event.target.value);
              /* Первый же символ уводит на экран результатов: искать, оставаясь
                 в списке, — значит показывать человеку не то, что он ищет. */
              if (event.target.value.trim() !== '') app.navigate({ name: 'search' });
            }}
            onFocus={() => {
              if (state.query.trim() !== '') app.navigate({ name: 'search' });
            }}
            onKeyDown={(event) => {
              /* Esc возвращает к списку и очищает запрос: поле остаётся на
                 месте, а человек — там, откуда начал. */
              if (event.key === 'Escape') {
                app.setQuery('');
                app.navigate({ name: 'list' });
                event.currentTarget.blur();
              }
            }}
          />
          <kbd className="za-listsearch__key">{strings.list.searchHotkey}</kbd>
        </div>
      ) : null}

      <div
        className={`za-scroll${isMobile && !embedded ? ' za-scroll--bottom-bar' : ''}`}
        onScroll={virtual.onScroll}
        {...pull.handlers}
      >
        {/* Проявление поиска пропорционально оттягиванию (BEHAVIOR §1.4). */}
        {pull.progress > 0 ? (
          <div className="za-pull" style={{ blockSize: 32 * pull.progress, opacity: pull.progress }}>
            {strings.search.title}
          </div>
        ) : null}
        {body}
      </div>

      {/* Нижняя зона mobile: пилюля поиска + FAB 52×52, градиент-фейд 96 px. */}
      {isMobile && !embedded ? (
        <>
          <div className="za-bottom__fade" aria-hidden="true" />
          <div className="za-bottom">
            <button
              type="button"
              className="za-bottom__search"
              onClick={() => app.navigate({ name: 'search' })}
            >
              <IconSearch size={15} />
              {strings.list.searchPlaceholder}
            </button>
            {!attachmentFolder ? (
              <Fab
                icon={<IconPlus size={22} />}
                label={strings.list.newNote}
                onClick={() => void app.createNote(state.folder ?? undefined)}
              />
            ) : null}
          </div>
        </>
      ) : null}

      <ContextMenu
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? strings.notes.untitled}
        items={menuFor ? noteMenuItems(menuFor) : []}
      />

      {/*
        Перенос заметки в папку. Раньше пункт «Переместить» открывал НАСТРОЙКИ
        ХРАНИЛИЩА — экран про путь к vault'у, к переносу отношения не имеющий.
      */}
      <FolderPickerDialog
        open={movingNote !== null}
        current={
          movingNote && movingNote.path.includes('/')
            ? movingNote.path.slice(0, movingNote.path.lastIndexOf('/'))
            : ''
        }
        folders={state.folders}
        onPick={(folder) => {
          if (movingNote) void app.move(movingNote.path, folder);
        }}
        onClose={() => setMovingNote(null)}
      />

      {/* Шифрование. Пункт «Зашифровать» просто открывал заметку. */}
      <EncryptSheet
        open={encrypting !== null}
        path={encrypting?.path ?? ''}
        onClose={() => setEncrypting(null)}
      />

      {/* Экспорт одной заметки. Пункт уводил в настройки переноса. */}
      <ContextMenu
        open={exporting !== null}
        onClose={() => setExporting(null)}
        title={strings.list.exportNote}
        items={(['md', 'html', 'docx', 'pdf'] as const).map((format) => ({
          id: format,
          label: format.toUpperCase(),
          onSelect: () => {
            if (exporting) void app.exportNoteAs(exporting.path, format);
          },
        }))}
      />

      <ContextMenu
        open={sortMenu}
        onClose={() => setSortMenu(false)}
        title={strings.list.sortMenu}
        items={(['updated', 'created', 'title', 'manual'] as SortMode[]).map((mode) => ({
          id: mode,
          label: strings.list.sort[mode],
          onSelect: () => app.setSortMode(state.folder, mode),
        }))}
      />
    </div>
  );

  /**
   * Путь заметки относительно открытой папки — или `null`, если она лежит
   * прямо в ней (тогда подписывать нечего) либо папка не открыта вовсе.
   */
  function subfolderOf(path: string, folder: string | null): string | null {
    if (folder === null) return null;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (dir === folder || !dir.startsWith(`${folder}/`)) return null;
    return dir.slice(folder.length + 1);
  }

  function noteMenuItems(note: NoteMeta): MenuItem[] {
    return [
      {
        id: 'pin',
        label: note.pinned ? strings.list.unpin : strings.list.pin,
        onSelect: () => void app.setPinned(note.path, !note.pinned),
      },
      /* У зашифрованной заметки «Дублировать» и «Экспорт» скрыты (BEHAVIOR §1.1). */
      {
        id: 'duplicate',
        label: strings.list.duplicate,
        hidden: note.encrypted,
        onSelect: () => void app.duplicate(note.path),
      },
      /*
        Три пункта ниже вели не туда. «Переместить» открывало настройки
        хранилища, «Зашифровать» просто открывало заметку, «Экспорт» уводило в
        настройки переноса. Со стороны это ровно то, что описал заказчик:
        «почти никакой функционал не работает, типа шифрования».
      */
      {
        id: 'move',
        label: strings.list.move,
        onSelect: () => setMovingNote(note),
      },
      {
        id: 'encrypt',
        label: strings.list.encrypt,
        hidden: note.encrypted,
        onSelect: () => setEncrypting(note),
      },
      /*
        Обратное действие было недостижимо ниоткуда: в этом меню его не было
        вовсе, а в меню открытой заметки подтверждение ничего не вызывало.
        Зашифровать заметку можно было, снять шифрование — нет.
      */
      {
        id: 'decrypt',
        label: strings.crypto.removeTitle,
        hidden: !note.encrypted,
        onSelect: () => app.askRemoveEncryption(note.path),
      },
      {
        id: 'export',
        label: strings.list.exportNote,
        hidden: note.encrypted,
        onSelect: () => setExporting(note),
      },
      {
        id: 'archive',
        label: note.archived ? strings.list.unarchive : strings.list.archive,
        onSelect: () => void app.archive(note.path, !note.archived),
      },
      {
        id: 'delete',
        label: strings.list.delete,
        danger: true,
        onSelect: () => void app.trashNote(note.path),
      },
    ];
  }
}
