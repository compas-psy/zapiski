import type { ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Feedback.css';

export interface SpinnerProps {
  /** 14–22 (COMPONENTS.md §7). По умолчанию 18. */
  size?: number;
  /** Подпись для скринридера. Без неё спиннер декоративный. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 18, label, className }: SpinnerProps): ReactNode {
  return (
    <span
      className={cx('z-spinner', className)}
      style={{ inlineSize: size, blockSize: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg className="z-spinner__svg" viewBox="0 0 24 24" width={size} height={size}>
        <circle className="z-spinner__track" cx="12" cy="12" r="9.5" />
        <circle className="z-spinner__head" cx="12" cy="12" r="9.5" />
      </svg>
    </span>
  );
}
