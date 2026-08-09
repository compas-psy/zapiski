import type { ReactNode } from 'react';
import { cx } from '../../internal/cx';
import { IconPause, IconPlay } from '../../icons';
import './Special.css';

/* ── Тулбар редактора ───────────────────────────────────────────────────── */

export interface ToolbarItem {
  id: string;
  icon: ReactNode;
  /** Подпись для скринридера и тултипа. */
  label: string;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface EditorToolbarProps {
  items: readonly ToolbarItem[];
  /** Подпись панели для скринридера. */
  label: string;
  className?: string;
}

/** Высота 44, фон --surface-alt, верхняя граница, элементы 34×34. */
export function EditorToolbar({ items, label, className }: EditorToolbarProps): ReactNode {
  return (
    <div className={cx('z-toolbar', className)} role="toolbar" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={cx('z-toolbar__item', item.active && 'z-toolbar__item--active')}
          aria-label={item.label}
          aria-pressed={item.active}
          disabled={item.disabled}
          onClick={item.onSelect}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

/* ── Мини-плеер ─────────────────────────────────────────────────────────── */

export interface MiniPlayerProps {
  playing: boolean;
  onTogglePlay: () => void;
  /** Подписи кнопки для скринридера в двух состояниях. */
  playLabel: string;
  pauseLabel: string;
  /** 0…1 — доля проигранного. */
  progress: number;
  /** Отформатированные тайминги (форматирование — забота вызывающего). */
  positionLabel: ReactNode;
  durationLabel: ReactNode;
  /** Текстовая скорость («1,5×») справа. */
  speedLabel?: ReactNode;
  onSpeedChange?: () => void;
  /** Подпись прогресса для скринридера. */
  progressLabel?: string;
  className?: string;
}

export function MiniPlayer({
  playing,
  onTogglePlay,
  playLabel,
  pauseLabel,
  progress,
  positionLabel,
  durationLabel,
  speedLabel,
  onSpeedChange,
  progressLabel,
  className,
}: MiniPlayerProps): ReactNode {
  const clamped = Math.min(1, Math.max(0, progress));
  return (
    <div className={cx('z-player', className)}>
      <button
        type="button"
        className="z-player__button"
        onClick={onTogglePlay}
        aria-label={playing ? pauseLabel : playLabel}
      >
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
      <div className="z-player__body">
        <div
          className="z-progress"
          role="progressbar"
          aria-label={progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clamped * 100)}
        >
          <span className="z-progress__fill" style={{ inlineSize: `${clamped * 100}%` }} />
        </div>
        <div className="z-player__times">
          <span>{positionLabel}</span>
          <span>{durationLabel}</span>
        </div>
      </div>
      {speedLabel ? (
        onSpeedChange ? (
          <button type="button" className="z-player__speed" onClick={onSpeedChange}>
            {speedLabel}
          </button>
        ) : (
          <span className="z-player__speed">{speedLabel}</span>
        )
      ) : null}
    </div>
  );
}

/* ── Строка с таймкодом ─────────────────────────────────────────────────── */

export interface TimecodeRowProps {
  /** Отформатированное время моно 10.5 в фиксированной колонке. */
  time: ReactNode;
  children: ReactNode;
  active?: boolean;
  onSelect?: () => void;
  className?: string;
}

export function TimecodeRow({
  time,
  children,
  active = false,
  onSelect,
  className,
}: TimecodeRowProps): ReactNode {
  return (
    <button
      type="button"
      className={cx('z-timecode', active && 'z-timecode--active', className)}
      aria-current={active || undefined}
      onClick={onSelect}
    >
      <span className="z-timecode__time">{time}</span>
      <span>{children}</span>
    </button>
  );
}

/* ── Вейвформа ──────────────────────────────────────────────────────────── */

export interface WaveformProps {
  /** Амплитуды 0…1, самая свежая — последняя. */
  values: readonly number[];
  /** Сколько столбцов показывать (последние N). По умолчанию 18. */
  bars?: number;
  /** Подпись для скринридера. */
  label?: string;
  className?: string;
}

/** Столбцы 3, gap 3, радиус 2, высота 8%–100%; свежие — акцент, старые гаснут. */
export function Waveform({ values, bars = 18, label, className }: WaveformProps): ReactNode {
  const tail = values.slice(-bars);
  const padded = [...Array.from({ length: Math.max(0, bars - tail.length) }, () => 0), ...tail];
  return (
    <div className={cx('z-waveform', className)} role="img" aria-label={label}>
      {padded.map((value, index) => {
        const freshness = padded.length > 1 ? index / (padded.length - 1) : 1;
        const height = 8 + Math.min(1, Math.max(0, value)) * 92;
        return (
          <span
            key={index}
            className="z-waveform__bar"
            style={{
              blockSize: `${height}%`,
              backgroundColor: `color-mix(in srgb, var(--accent) ${Math.round(freshness * 100)}%, var(--line))`,
            }}
          />
        );
      })}
    </div>
  );
}

/* ── Diff ───────────────────────────────────────────────────────────────── */

export type DiffLineType = 'add' | 'remove' | 'context';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffProps {
  lines: readonly DiffLine[];
  /** Подпись блока для скринридера. */
  label?: string;
  className?: string;
}

/** Добавления — success-soft, удаления — danger-soft + line-through. */
export function Diff({ lines, label, className }: DiffProps): ReactNode {
  return (
    <div className={cx('z-diff', className)} role="group" aria-label={label}>
      {lines.map((line, index) => (
        <span
          key={index}
          className={cx(
            'z-diff__line',
            line.type === 'add' && 'z-diff__line--add',
            line.type === 'remove' && 'z-diff__line--remove',
          )}
        >
          {line.text}
        </span>
      ))}
    </div>
  );
}

export interface DiffInlineProps {
  type: 'add' | 'remove';
  children: ReactNode;
  className?: string;
}

export function DiffInline({ type, children, className }: DiffInlineProps): ReactNode {
  return <span className={cx('z-diff-inline', `z-diff-inline--${type}`, className)}>{children}</span>;
}
