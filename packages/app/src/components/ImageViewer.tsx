/**
 * Полноэкранный просмотр картинки (ITERATION-1 §5).
 *
 * «Тап — полноэкранный просмотр, свайп вниз закрывает». До этого тап по
 * превью ставил курсор в текст: единственный способ разглядеть вложение
 * состоял в том, чтобы открыть файл в другом приложении.
 *
 * Свайп вниз, а не «крестик и всё»: жест здесь главный способ закрытия на
 * телефоне, и он обязан ощущаться живым — картинка едет за пальцем и гаснет
 * по мере ухода. Оборванный жест (палец вернулся) возвращает её на место, а
 * не закрывает: иначе просмотр закрывался бы от случайного касания.
 *
 * Клавиатура: Esc закрывает, фокус уходит на слой и не возвращается в текст
 * раньше времени.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, IconClose } from '@zapiski/ui';
import { useStrings } from '../state/context.js';

export interface ImageViewerProps {
  /** URL картинки; `null` — просмотр закрыт. */
  src: string | null;
  alt: string;
  onClose: () => void;
}

/** Насколько нужно утянуть картинку вниз, чтобы жест засчитался закрытием. */
const CLOSE_AT = 120;

export function ImageViewer({ src, alt, onClose }: ImageViewerProps): ReactNode {
  const strings = useStrings();
  const layer = useRef<HTMLDivElement>(null);
  /** Смещение по вертикали за пальцем; 0 — картинка на месте. */
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  /* То же смещение зеркалом в ref: решение о закрытии принимается в момент
     отрыва пальца, а вызывать `onClose` из функции-обновителя нельзя — она
     обязана быть чистой, React ругается на setState чужого компонента. */
  const offset = useRef(0);

  useEffect(() => {
    if (src === null) return;
    setDrag(0);
    layer.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  const move = useCallback((event: React.PointerEvent) => {
    if (start.current === null) return;
    /* Только вниз: тянуть картинку вверх некуда, а «резинка» вверх выглядела
       бы как незакрывшееся окно. */
    offset.current = Math.max(0, event.clientY - start.current);
    setDrag(offset.current);
  }, []);

  const end = useCallback(() => {
    if (start.current === null) return;
    start.current = null;
    const travelled = offset.current;
    offset.current = 0;
    setDrag(0);
    if (travelled >= CLOSE_AT) onClose();
  }, [onClose]);

  if (src === null || typeof document === 'undefined') return null;

  /* Фон гаснет вместе с уходящей картинкой — жест виден до того, как палец
     оторван, и понятно, чем он кончится. */
  const progress = Math.min(1, drag / (CLOSE_AT * 2));

  return createPortal(
    <div
      ref={layer}
      className="za-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt || strings.attachments.title}
      tabIndex={-1}
      style={{ opacity: String(1 - progress * 0.6) }}
      onPointerDown={(event) => {
        start.current = event.clientY;
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      /* Клик мимо картинки — тоже закрытие: это привычно и на десктопе
         быстрее, чем целиться в крестик. */
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="za-viewer__bar">
        <IconButton
          icon={<IconClose size={20} />}
          label={strings.app.close}
          tone="ghost"
          onClick={onClose}
        />
      </div>
      <img
        className="za-viewer__image"
        src={src}
        alt={alt}
        draggable={false}
        style={
          drag > 0
            ? { transform: `translateY(${drag}px)`, transition: 'none' }
            : undefined
        }
      />
    </div>,
    document.body,
  );
}
