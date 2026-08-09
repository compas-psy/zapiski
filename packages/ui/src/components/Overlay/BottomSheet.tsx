import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../internal/cx';
import { useOverlay } from '../../internal/useOverlay';
import './Overlay.css';

/** После какого сдвига вниз лист закрывается. */
const CLOSE_AT = 96;

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Заголовок листа; он же — метка для скринридера. */
  title?: ReactNode;
  /** Если заголовка нет — обязательна текстовая метка. */
  label?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Показывать «ручку» 36×4 (по умолчанию да). */
  handle?: boolean;
  className?: string;
}

/**
 * Bottom sheet (mobile) — радиус 16 16 0 0, ручка 36×4, паддинг 24 по бокам,
 * тень 0 -12px 40px --scrim. Закрытие: свайп вниз, тап по скриму, Esc.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  label,
  children,
  footer,
  handle = true,
  className,
}: BottomSheetProps): ReactNode {
  const { ref, titleId } = useOverlay<HTMLDivElement>({ open, onClose });
  const [dragY, setDragY] = useState(0);
  const startY = useRef<number | null>(null);

  if (!open || typeof document === 'undefined') return null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    startY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (startY.current === null) return;
    setDragY(Math.max(0, event.clientY - startY.current));
  };
  const onPointerUp = (): void => {
    const shouldClose = dragY >= CLOSE_AT;
    startY.current = null;
    setDragY(0);
    if (shouldClose) onClose();
  };

  return createPortal(
    <>
      <div className="z-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title ? undefined : label}
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cx('z-sheet', dragY > 0 && 'z-sheet--dragging', className)}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
      >
        {handle ? (
          <div
            className="z-sheet__handle"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        ) : null}
        {title ? (
          <h2 className="z-sheet__title" id={titleId}>
            {title}
          </h2>
        ) : null}
        {children}
        {footer ? <div className="z-overlay__footer">{footer}</div> : null}
      </div>
    </>,
    document.body,
  );
}
