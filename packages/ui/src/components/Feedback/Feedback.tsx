import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Feedback.css';

/* ── Прогресс ────────────────────────────────────────────────────────────── */

export interface ProgressProps {
  /** 0…1. Не задано — неопределённый прогресс. */
  value?: number;
  /** Подпись для скринридера. */
  label?: string;
  className?: string;
}

export function Progress({ value, label, className }: ProgressProps): ReactNode {
  const indeterminate = value === undefined;
  const clamped = indeterminate ? 0 : Math.min(1, Math.max(0, value));
  return (
    <div
      className={cx('z-progress', indeterminate && 'z-progress--indeterminate', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped * 100)}
    >
      <span
        className="z-progress__fill"
        style={indeterminate ? undefined : { inlineSize: `${clamped * 100}%` }}
      />
    </div>
  );
}

/* ── Скелетон ────────────────────────────────────────────────────────────── */

export interface SkeletonProps {
  variant?: 'title' | 'line' | 'block';
  /** CSS-длина: '62%', '8rem'. */
  width?: string;
  height?: string;
  className?: string;
  style?: CSSProperties;
}

export function Skeleton({
  variant = 'line',
  width,
  height,
  className,
  style,
}: SkeletonProps): ReactNode {
  return (
    <span
      className={cx('z-skeleton', `z-skeleton--${variant}`, className)}
      style={{ inlineSize: width, blockSize: height, ...style }}
      aria-hidden="true"
    />
  );
}

export interface SkeletonListProps {
  /** Сколько строк-заглушек показать. */
  rows?: number;
  /** Подпись для скринридера: «загружаем список». */
  label?: string;
  className?: string;
}

/** Скелетон списка заметок: заголовок 13 + две строки 10 (SCREENS.md §3). */
export function SkeletonList({ rows = 6, label, className }: SkeletonListProps): ReactNode {
  return (
    <div className={className} role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="z-skeleton-row" key={index}>
          <Skeleton variant="title" />
          <Skeleton variant="line" width="92%" />
          <Skeleton variant="line" width="64%" />
        </div>
      ))}
    </div>
  );
}

/* ── Плашка-пояснение ────────────────────────────────────────────────────── */

export type NoteTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export interface InfoNoteProps {
  children: ReactNode;
  /** Иконка 15 слева (для приватных сообщений — замок). */
  icon?: ReactNode;
  tone?: NoteTone;
  className?: string;
}

export function InfoNote({ children, icon, tone = 'neutral', className }: InfoNoteProps): ReactNode {
  return (
    <div className={cx('z-note', tone !== 'neutral' && `z-note--${tone}`, className)}>
      {icon ? <span className="z-note__icon">{icon}</span> : null}
      <div className="z-note__body">{children}</div>
    </div>
  );
}

/* ── Пустое состояние ────────────────────────────────────────────────────── */

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Ровно одна кнопка — COMPONENTS.md §7. Тип запрещает передать список. */
  action?: ReactElement;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): ReactNode {
  return (
    <div className={cx('z-empty', className)}>
      {icon ? <span className="z-empty__circle">{icon}</span> : null}
      <p className="z-empty__title">{title}</p>
      {description ? <p className="z-empty__description">{description}</p> : null}
      {action ? <div className="z-empty__action">{action}</div> : null}
    </div>
  );
}

/* ── Индикатор синка ─────────────────────────────────────────────────────── */

export type SyncStatus = 'synced' | 'offline' | 'syncing' | 'error';

export interface SyncDotProps {
  status: SyncStatus;
  /** Текстовая расшифровка статуса для скринридера. */
  label: string;
  className?: string;
}

/** Точка 6 px. Пульсация запрещена (DESIGN_TOKENS.md §1). */
export function SyncDot({ status, label, className }: SyncDotProps): ReactNode {
  return (
    <span
      className={cx('z-sync-dot', status !== 'offline' && `z-sync-dot--${status}`, className)}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
