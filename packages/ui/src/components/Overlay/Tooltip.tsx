import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../internal/cx';
import './Overlay.css';

/** Задержка появления — 500 мс (COMPONENTS.md §6). */
export const TOOLTIP_DELAY_MS = 500;

export interface TooltipProps {
  /** Текст подсказки. */
  content: ReactNode;
  children: ReactNode;
  /** Показать снизу вместо сверху. */
  below?: boolean;
  delay?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  below = false,
  delay = TOOLTIP_DELAY_MS,
  className,
}: TooltipProps): ReactNode {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = `z-tooltip-${useId()}`;

  const cancel = (): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const schedule = (): void => {
    cancel();
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = (): void => {
    cancel();
    setOpen(false);
  };

  useEffect(() => cancel, []);

  /* Esc закрывает подсказку — общее правило оверлеев. */
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <span
      className={cx('z-tooltip-anchor', className)}
      onPointerEnter={schedule}
      onPointerLeave={hide}
      onFocus={schedule}
      onBlur={hide}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span className={cx('z-tooltip', below && 'z-tooltip--below')} role="tooltip" id={id}>
          {content}
        </span>
      ) : null}
    </span>
  );
}
