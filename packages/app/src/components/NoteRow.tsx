/**
 * Строка списка заметок — SCREENS §3 и BEHAVIOR §1.1.
 *
 * Почему не `ListRow` из `@zapiski/ui`: строке нужны пропорциональное
 * проявление подложки, порог по скорости и ТП на срабатывании — механика
 * BEHAVIOR §1.1, которой в библиотечной строке нет. Разметка и токены — те же.
 */
import { useMemo, type ReactNode } from 'react';
import type { NoteMeta } from '@zapiski/core';
import { IconLock, IconPaperclip, IconPin } from '@zapiski/ui';
import { useSwipe, useLongPress, type Haptic } from '../lib/gestures.js';
import { relativeTime } from '../lib/format.js';
import { useStrings } from '../state/context.js';

export interface NoteRowProps {
  note: NoteMeta;
  selected?: boolean;
  compact?: boolean;
  onOpen: () => void;
  /** Свайп вправо: закрепить/открепить. Работает и на зашифрованной заметке. */
  onSwipeRight?: () => void;
  /** Свайп влево: в архив / вернуть из архива. */
  onSwipeLeft?: () => void;
  onLongPress: () => void;
  haptic?: Haptic | undefined;
  /** Подписи подложек — зависят от того, закреплена ли заметка и в архиве ли. */
  rightLabel: string;
  leftLabel: string;
}

export function NoteRow({
  note,
  selected = false,
  compact = false,
  onOpen,
  onSwipeRight,
  onSwipeLeft,
  onLongPress,
  haptic,
  rightLabel,
  leftLabel,
}: NoteRowProps): ReactNode {
  const strings = useStrings();
  const swipe = useSwipe({
    onRight: onSwipeRight,
    onLeft: onSwipeLeft,
    ...(haptic ? { haptic } : {}),
  });
  const longPress = useLongPress(onLongPress, haptic);

  const meta = useMemo(
    () => `${relativeTime(note.updatedAt, strings)} · ${strings.list.words(note.wordCount)}`,
    [note.updatedAt, note.wordCount, strings],
  );

  const direction = swipe.offset > 0 ? 'start' : 'end';
  const label = swipe.offset > 0 ? rightLabel : leftLabel;

  return (
    <div className="za-row-shell">
      {swipe.offset !== 0 ? (
        <div
          className={`za-row__underlay za-row__underlay--${direction}`}
          aria-hidden="true"
          /* До порога подложка проявляется пропорционально смещению (0→96). */
          style={{ opacity: swipe.reveal }}
        >
          {swipe.offset > 0 ? <IconPin size={17} /> : null}
          <span>{label}</span>
        </div>
      ) : null}
      <button
        type="button"
        className={[
          'za-row',
          compact ? 'za-row--compact' : '',
          selected ? 'za-row--selected' : '',
          swipe.offset === 0 && swipe.releasing ? 'za-row--releasing' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-current={selected || undefined}
        style={swipe.offset !== 0 ? { transform: `translateX(${swipe.offset}px)` } : undefined}
        onClick={onOpen}
        {...swipe.handlers}
        onPointerDown={(event) => {
          swipe.handlers.onPointerDown(event);
          longPress.onPointerDown(event);
        }}
        onPointerUp={(event) => {
          swipe.handlers.onPointerUp(event);
          longPress.onPointerUp();
        }}
        onPointerCancel={(event) => {
          swipe.handlers.onPointerCancel(event);
          longPress.onPointerUp();
        }}
        onPointerLeave={longPress.onPointerLeave}
        onContextMenu={longPress.onContextMenu}
      >
        <span className="za-row__body">
          <span className="za-row__head">
            <span className="za-row__title">{note.title || strings.notes.untitled}</span>
            <span className="za-row__marks">
              {note.pinned ? <IconPin size={13} aria-label={strings.list.markPinned} /> : null}
              {note.hasFile || note.hasImage ? (
                <IconPaperclip size={13} aria-label={strings.list.markAttachment} />
              ) : null}
              {note.encrypted ? (
                <IconLock size={13} aria-label={strings.list.markEncrypted} />
              ) : null}
            </span>
          </span>
          {note.encrypted ? (
            <span className="za-row__snippet za-row__snippet--muted">{strings.list.encrypted}</span>
          ) : (
            <span className="za-row__snippet">{note.snippet}</span>
          )}
          <span className="za-row__meta">{meta}</span>
        </span>
      </button>
    </div>
  );
}
