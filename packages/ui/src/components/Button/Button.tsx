import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../internal/cx';
import { Spinner } from '../Feedback/Spinner';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'text' | 'destructive';
export type ControlSize = 'default' | 'compact';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** Подпись. Ни одной строки не зашито внутрь — всё приходит пропсами. */
  children?: ReactNode;
  variant?: ButtonVariant;
  /** default — 44, compact — 36 (зона нажатия остаётся 44). */
  size?: ControlSize;
  /** Загрузка: кольцо 14 px слева от процессной подписи, ширина не прыгает. */
  loading?: boolean;
  /** Процессная подпись («Отправляем»). Без неё остаётся обычная. */
  loadingLabel?: ReactNode;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
}

export function Button({
  children,
  variant = 'primary',
  size = 'default',
  loading = false,
  loadingLabel,
  iconStart,
  iconEnd,
  fullWidth = false,
  className,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={cx(
        'z-btn',
        `z-btn--${variant}`,
        size === 'compact' && 'z-btn--compact',
        fullWidth && 'z-btn--full',
        className,
      )}
    >
      <span className="z-btn__stack">
        <span
          className={cx('z-btn__face', loading && 'z-btn__face--hidden')}
          aria-hidden={loading || undefined}
        >
          {iconStart ? <span className="z-btn__icon">{iconStart}</span> : null}
          {children}
          {iconEnd ? <span className="z-btn__icon">{iconEnd}</span> : null}
        </span>
        <span
          className={cx('z-btn__face', !loading && 'z-btn__face--hidden')}
          aria-hidden={!loading || undefined}
        >
          <Spinner size={14} />
          {loadingLabel ?? children}
        </span>
      </span>
    </button>
  );
}

export interface FabProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  icon: ReactNode;
  /** Обязательная подпись для скринридера. */
  label: string;
}

/** FAB 52×52, радиус 18, тень акцентом 35% (DESIGN_TOKENS.md §3). */
export function Fab({ icon, label, className, type = 'button', ...rest }: FabProps): ReactNode {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cx('z-fab', className)}
    >
      {icon}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** Глиф. */
  icon: ReactNode;
  /** Обязательная подпись для скринридера (TalkBack/Narrator). */
  label: string;
  size?: ControlSize;
  tone?: 'surface' | 'ghost' | 'accent';
}

export function IconButton({
  icon,
  label,
  size = 'default',
  tone = 'surface',
  className,
  type = 'button',
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'z-icon-btn',
        tone === 'ghost' && 'z-icon-btn--ghost',
        tone === 'accent' && 'z-icon-btn--accent',
        size === 'compact' && 'z-icon-btn--compact',
        className,
      )}
    >
      {icon}
    </button>
  );
}
