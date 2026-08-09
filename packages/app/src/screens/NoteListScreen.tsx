/**
 * Список заметок — SCREENS §3, BEHAVIOR §1.
 *
 * Здесь собраны: секции «ЗАКРЕПЛЁННЫЕ» + месяцы, свайпы с порогом 96 px,
 * long-press-меню, виртуализация при >100 строк, pull-to-search и
 * pull-to-refresh двумя пальцами, а также все ячейки матрицы §12 для этого
 * экрана.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { NoteMeta } from '@zapiski/core';
import { Button, Fab, IconButton, IconPlus, IconSearch } from '@zapiski/ui';
import { useApp, useAppState, useLayout, useStrings } from '../state/context.js';
import { IconMenu } from '../components/icons.js';
import { NoteRow } from '../components/NoteRow.js';
import { ContextMenu, type MenuItem } from '../components/ContextMenu.js';
import { SyncIndicator } from '../components/SyncIndicator.js';
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
  const [sortMenu, setSortMenu] = useState(false);

  const haptic = app.host.platform.haptics
    ? app.host.platform.haptics.impact.bind(app.host.platform.haptics)
    : undefined;

  const filter = { scope: state.scope, folder: state.folder, tag: state.tag };
  const notes = useMemo(() => selectNotes(state.notes, filter), [state.notes, filter.scope, filter.folder, filter.tag]);
  const sortMode = app.sortModeFor(state.folder);
  const items = useMemo(
    () => flatten(buildSections(notes, sortMode, strings)),
    [notes, sortMode, strings],
  );

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
        <h1 className="za-h1 za-h1--mobile za-header__title">{title}</h1>
        {/* Оффлайн — чип-пилюля в шапке, не блокирующий баннер (SCREENS §3). */}
        {screenState === 'offline' ? (
          <span className="za-chip">{strings.errors.offline}</span>
        ) : null}
        <div className="za-header__actions">
          <SyncIndicator />
          <IconButton
            icon={<span aria-hidden="true">⋯</span>}
            label={strings.list.sortMenu}
            tone="ghost"
            onClick={() => setSortMenu(true)}
          />
        </div>
      </div>

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
            <Fab
              icon={<IconPlus size={22} />}
              label={strings.list.newNote}
              onClick={() => void app.createNote(state.folder ?? undefined)}
            />
          </div>
        </>
      ) : null}

      <ContextMenu
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? strings.notes.untitled}
        items={menuFor ? noteMenuItems(menuFor) : []}
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
      {
        id: 'move',
        label: strings.list.move,
        onSelect: () => app.navigate({ name: 'settings', section: 'storage' }),
      },
      {
        id: 'encrypt',
        label: strings.list.encrypt,
        hidden: note.encrypted,
        onSelect: () => app.openNote(note.path),
      },
      {
        id: 'export',
        label: strings.list.exportNote,
        hidden: note.encrypted,
        onSelect: () => app.navigate({ name: 'settings', section: 'transfer' }),
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
