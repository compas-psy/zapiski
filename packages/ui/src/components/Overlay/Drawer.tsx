import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../internal/cx';
import { useOverlay } from '../../internal/useOverlay';
import './Overlay.css';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Метка панели для скринридера. */
  label: string;
  children: ReactNode;
  /** Сторона появления. По умолчанию слева (библиотека). */
  side?: 'start' | 'end';
  /** Показывать скрим (mobile — да, desktop-сайдбар обычно без). */
  scrim?: boolean;
  className?: string;
}

/** Drawer: 302 (mobile) / 224 (desktop), радиус 0 22 22 0, тень 12px 0 40px. */
export function Drawer({
  open,
  onClose,
  label,
  children,
  side = 'start',
  scrim = true,
  className,
}: DrawerProps): ReactNode {
  const { ref } = useOverlay<HTMLDivElement>({ open, onClose });
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <>
      {scrim ? <div className="z-scrim" onClick={onClose} aria-hidden="true" /> : null}
      <div
        ref={ref}
        role="dialog"
        aria-modal={scrim || undefined}
        aria-label={label}
        tabIndex={-1}
        className={cx('z-drawer', side === 'end' && 'z-drawer--end', className)}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
