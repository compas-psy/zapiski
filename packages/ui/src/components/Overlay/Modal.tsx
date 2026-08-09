import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../internal/cx';
import { useOverlay } from '../../internal/useOverlay';
import { IconButton } from '../Button/Button';
import { IconClose } from '../../icons';
import './Overlay.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Метка для скринридера, если заголовка нет. */
  label?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Подпись кнопки закрытия. Без неё крестик не рисуется. */
  closeLabel?: string;
  /** 560 вместо 480. */
  wide?: boolean;
  className?: string;
}

/** Модалка (desktop): ширина 480–560, радиус 16, отступ сверху 78, fade + 8 px. */
export function Modal({
  open,
  onClose,
  title,
  label,
  children,
  footer,
  closeLabel,
  wide = false,
  className,
}: ModalProps): ReactNode {
  const { ref, titleId } = useOverlay<HTMLDivElement>({ open, onClose });
  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div className="z-scrim" onClick={onClose} aria-hidden="true" />
      <div className="z-modal-layer">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={title ? undefined : label}
          aria-labelledby={title ? titleId : undefined}
          tabIndex={-1}
          className={cx('z-modal', wide && 'z-modal--wide', className)}
        >
          {title || closeLabel ? (
            <div className="z-modal__head">
              {title ? (
                <h2 className="z-modal__title" id={titleId}>
                  {title}
                </h2>
              ) : (
                <span />
              )}
              {closeLabel ? (
                <IconButton
                  icon={<IconClose size={18} />}
                  label={closeLabel}
                  tone="ghost"
                  size="compact"
                  onClick={onClose}
                />
              ) : null}
            </div>
          ) : null}
          {children}
          {footer ? <div className="z-overlay__footer">{footer}</div> : null}
        </div>
      </div>
    </>,
    document.body,
  );
}
