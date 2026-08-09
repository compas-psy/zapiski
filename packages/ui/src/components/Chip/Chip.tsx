/**
 * Чипы, теги, бейджи.
 *
 * РЕАЛИЗАЦИЯ ДО ПОЯВЛЕНИЯ ПАКЕТА СИМПАС. `Badge` — компонент
 * дизайн-системы (DS-ALIGNMENT §8); пока `@simpas/design-system` недоступен,
 * здесь живёт наша версия с тем же API и видом. Карта соответствия и план
 * замены — packages/ui/DS-MAPPING.md. Значения не выдумываются: всё построено
 * на токенах системы через алиасы из styles/tokens.css.
 */
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../internal/cx';
import { IconClose } from '../../icons';
import './Chip.css';

/* ── Ряд чипов: скролл, не перенос ───────────────────────────────────────── */

export interface ChipRowProps extends ComponentPropsWithRef<'div'> {
  /** Скроллить горизонтально без видимой полосы (по умолчанию да). */
  scrollable?: boolean;
  /** Подпись группы для скринридера. */
  label?: string;
}

export function ChipRow({
  scrollable = true,
  label,
  className,
  children,
  ...rest
}: ChipRowProps): ReactNode {
  return (
    <div
      {...rest}
      role={label ? 'group' : undefined}
      aria-label={label}
      className={cx('z-chip-row', scrollable && 'z-scroll-x', className)}
    >
      {children}
    </div>
  );
}

/* ── Тег ─────────────────────────────────────────────────────────────────── */

export interface TagProps extends ComponentPropsWithRef<'span'> {
  variant?: 'accent' | 'outline' | 'surface';
  icon?: ReactNode;
}

export function Tag({ variant = 'accent', icon, className, children, ...rest }: TagProps): ReactNode {
  return (
    <span {...rest} className={cx('z-tag', variant !== 'accent' && `z-tag--${variant}`, className)}>
      {icon}
      {children}
    </span>
  );
}

/* ── Фильтр ──────────────────────────────────────────────────────────────── */

export interface FilterChipProps extends Omit<ComponentPropsWithRef<'button'>, 'onSelect'> {
  active?: boolean;
  /** Крестик сброса справа. */
  onReset?: () => void;
  /** Подпись крестика для скринридера. */
  resetLabel?: string;
  icon?: ReactNode;
}

export function FilterChip({
  active = false,
  onReset,
  resetLabel,
  icon,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: FilterChipProps): ReactNode {
  if (!onReset) {
    return (
      <button
        {...rest}
        type={type}
        disabled={disabled}
        aria-pressed={active}
        className={cx('z-filter', active && 'z-filter--active', className)}
      >
        {icon}
        {children}
      </button>
    );
  }

  /* Со сбросом — контейнер-обёртка: вложенные <button> недопустимы. */
  return (
    <span
      className={cx('z-filter', 'z-filter--with-reset', active && 'z-filter--active', className)}
    >
      <button
        {...rest}
        type={type}
        disabled={disabled}
        aria-pressed={active}
        className="z-filter__main"
      >
        {icon}
        {children}
      </button>
      <button
        type="button"
        className="z-filter__reset"
        disabled={disabled}
        aria-label={resetLabel}
        onClick={onReset}
      >
        <IconClose size={10} />
      </button>
    </span>
  );
}

/* ── Бейдж статуса ───────────────────────────────────────────────────────── */

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone;
  icon?: ReactNode;
}

export function Badge({ tone = 'neutral', icon, className, children, ...rest }: BadgeProps): ReactNode {
  return (
    <span {...rest} className={cx('z-badge', tone !== 'neutral' && `z-badge--${tone}`, className)}>
      {icon}
      {children}
    </span>
  );
}
