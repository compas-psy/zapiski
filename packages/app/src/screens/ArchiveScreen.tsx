/**
 * Архив — SCREENS §11 (экран из «ещё не отрисовано», делается по спецификации)
 * и матрица BEHAVIOR §12: пустое состояние и скелетоны.
 *
 * Свайп влево на архивной заметке — «Вернуть из архива» (BEHAVIOR §1.1).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { NoteMeta } from '@zapiski/core';
import { IconArrowLeft, IconButton } from '@zapiski/ui';
import { useApp, useAppState, useStrings } from '../state/context.js';
import { NoteRow } from '../components/NoteRow.js';
import { ContextMenu } from '../components/ContextMenu.js';
import { EmptyBlock, ListSkeleton } from '../components/ScreenStates.js';
import { IconArchive } from '../components/icons.js';

export function ArchiveScreen(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const [menuFor, setMenuFor] = useState<NoteMeta | null>(null);

  const notes = useMemo(
    () => state.notes.filter((note) => note.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [state.notes],
  );
  const screenState = app.screenState('archive', notes.length === 0);

  const haptic = app.host.platform.haptics
    ? app.host.platform.haptics.impact.bind(app.host.platform.haptics)
    : undefined;

  return (
    <div className="za-bottom__host">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{strings.archive.title}</h1>
      </div>
      <div className="za-scroll">
        {screenState === 'loading' ? (
          <ListSkeleton rows={5} />
        ) : screenState === 'empty' ? (
          <EmptyBlock title={strings.empty.archive} icon={<IconArchive size={24} />} />
        ) : (
          notes.map((note) => (
            <NoteRow
              key={note.path}
              note={note}
              onOpen={() => app.openNote(note.path)}
              onSwipeLeft={() => void app.archive(note.path, false)}
              onLongPress={() => setMenuFor(note)}
              haptic={haptic}
              rightLabel={note.pinned ? strings.list.unpin : strings.list.pin}
              leftLabel={strings.list.unarchive}
            />
          ))
        )}
      </div>

      <ContextMenu
        open={menuFor !== null}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? ''}
        items={
          menuFor
            ? [
                {
                  id: 'unarchive',
                  label: strings.list.unarchive,
                  onSelect: () => void app.archive(menuFor.path, false),
                },
                {
                  id: 'delete',
                  label: strings.list.delete,
                  danger: true,
                  onSelect: () => void app.trashNote(menuFor.path),
                },
              ]
            : []
        }
      />
    </div>
  );
}
