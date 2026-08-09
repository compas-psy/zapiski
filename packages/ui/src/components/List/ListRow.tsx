import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './List.css';

/** Порог срабатывания свайпа — 96 px (SCREENS.md §3). */
const SWIPE_THRESHOLD = 96;
const SWIPE_MAX = 132;

export interface SwipeAction {
  icon?: ReactNode;
  label: ReactNode;
  /** accent — «закрепить», surface — «в архив». */
  tone?: 'accent' | 'surface';
  onAction: () => void;
}

export interface ListRowProps {
  title: ReactNode;
  /** Сниппет — максимум 2 строки с ellipsis. */
  snippet?: ReactNode;
  /** Приглушённый курсив вместо сниппета (зашифрованная заметка). */
  snippetMuted?: boolean;
  /** Метастрока моно 10.5. */
  meta?: ReactNode;
  /** Пиктограммы 13 px справа от заголовка. */
  marks?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  /** Компактная строка 58 вместо 74. */
  compact?: boolean;
  onClick?: () => void;
  /** Свайп вправо (по умолчанию — закрепить, подложка акцентом). */
  swipeRight?: SwipeAction;
  /** Свайп влево (по умолчанию — архив, подложка --surface). */
  swipeLeft?: SwipeAction;
  className?: string;
  id?: string;
}

export function ListRow({
  title,
  snippet,
  snippetMuted = false,
  meta,
  marks,
  leading,
  trailing,
  selected = false,
  compact = false,
  onClick,
  swipeRight,
  swipeLeft,
  className,
  id,
}: ListRowProps): ReactNode {
  const [offset, setOffset] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef<'none' | 'x' | 'y'>('none');
  const swipeable = Boolean(swipeRight ?? swipeLeft);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!swipeable || event.pointerType === 'mouse') return;
    start.current = { x: event.clientX, y: event.clientY };
    axis.current = 'none';
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const origin = start.current;
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (axis.current === 'none') {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis.current === 'x') event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (axis.current !== 'x') return;
    const allowed = dx > 0 ? Boolean(swipeRight) : Boolean(swipeLeft);
    setOffset(allowed ? Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, dx)) : 0);
  };

  const finish = (): void => {
    const current = offset;
    start.current = null;
    axis.current = 'none';
    setOffset(0);
    if (current >= SWIPE_THRESHOLD) swipeRight?.onAction();
    else if (current <= -SWIPE_THRESHOLD) swipeLeft?.onAction();
  };

  const activeAction = offset > 0 ? swipeRight : offset < 0 ? swipeLeft : undefined;
  const tone = activeAction?.tone ?? (offset > 0 ? 'accent' : 'surface');

  return (
    <div className={cx('z-row-wrap', className)} id={id}>
      {activeAction ? (
        <div
          className={cx('z-row__underlay', tone === 'accent' ? 'z-row__underlay--start' : 'z-row__underlay--end')}
          aria-hidden="true"
        >
          {activeAction.icon}
          <span>{activeAction.label}</span>
        </div>
      ) : null}
      <div
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-current={selected || undefined}
        className={cx(
          'z-row',
          compact && 'z-row--compact',
          selected && 'z-row--selected',
          offset !== 0 && 'z-row--swiping',
          !onClick && 'z-row--static',
        )}
        style={offset !== 0 ? { transform: `translateX(${offset}px)` } : undefined}
        onClick={onClick}
        onKeyDown={(event) => {
          if (!onClick) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick();
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        {leading ? <span className="z-row__leading">{leading}</span> : null}
        <span className="z-row__body">
          <span className="z-row__head">
            <span className="z-row__title">{title}</span>
            {marks ? <span className="z-row__marks">{marks}</span> : null}
          </span>
          {snippet ? (
            <span className={cx('z-row__snippet', snippetMuted && 'z-row__snippet--muted')}>
              {snippet}
            </span>
          ) : null}
          {meta ? <span className="z-row__meta">{meta}</span> : null}
        </span>
        {trailing ? <span className="z-row__trailing">{trailing}</span> : null}
      </div>
    </div>
  );
}

export interface ListProps {
  children: ReactNode;
  /** Подпись списка для скринридера. */
  label?: string;
  className?: string;
}

export function List({ children, label, className }: ListProps): ReactNode {
  return (
    <div className={cx('z-list', className)} role="list" aria-label={label}>
      {children}
    </div>
  );
}

export interface SectionLabelProps {
  children: ReactNode;
  /** Счётчик/иконка справа. */
  trailing?: ReactNode;
  className?: string;
}

/** Секционная подпись CAPS 10.5/700/.09em --text-tertiary. */
export function SectionLabel({ children, trailing, className }: SectionLabelProps): ReactNode {
  return (
    <div className={cx('z-section-label', className)}>
      {children}
      {trailing}
    </div>
  );
}
