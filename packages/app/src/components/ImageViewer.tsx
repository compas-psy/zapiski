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
  /**
   * Ширина картинки в заметке и её изменение (замечание 2). Без обработчика
   * кнопки размера не показываются: у картинки по внешней ссылке менять в
   * тексте нечего.
   */
  width?: number | null;
  onWidth?: (width: number | null) => void;
  /**
   * Обрезка. Рамка приходит долями от 0 до 1 — так она не зависит от того, в
   * каком масштабе её тянули на экране. Без обработчика режим недоступен.
   */
  onCrop?: (rect: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
}

/** Насколько нужно утянуть картинку вниз, чтобы жест засчитался закрытием. */
const CLOSE_AT = 120;

/** Шаги ширины в заметке. Крайние — «узкая колонка» и «во всю ширину». */
const WIDTHS = [240, 320, 420, 560, 720] as const;

export function ImageViewer({
  src,
  alt,
  onClose,
  width = null,
  onWidth,
  onCrop,
}: ImageViewerProps): ReactNode {
  const strings = useStrings();
  const layer = useRef<HTMLDivElement>(null);
  /** Смещение по вертикали за пальцем; 0 — картинка на месте. */
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  /* То же смещение зеркалом в ref: решение о закрытии принимается в момент
     отрыва пальца, а вызывать `onClose` из функции-обновителя нельзя — она
     обязана быть чистой, React ругается на setState чужого компонента. */
  const offset = useRef(0);
  /** Идёт ли кадрирование. В этом режиме жест закрытия выключен: палец рисует
      рамку, и «свайп вниз» означал бы потерю начатого. */
  const [cropping, setCropping] = useState(false);
  /** Рамка в долях картинки; `null` — ещё не начата. */
  const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const cropStart = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLImageElement>(null);
  const [busy, setBusy] = useState(false);

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

  /** Доля точки внутри картинки — рамка не зависит от масштаба показа. */
  const fractionOf = (event: React.PointerEvent): { x: number; y: number } | null => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    };
  };

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
        if (cropping) {
          const at = fractionOf(event);
          if (!at) return;
          cropStart.current = at;
          setRect({ x: at.x, y: at.y, width: 0, height: 0 });
          return;
        }
        start.current = event.clientY;
      }}
      onPointerMove={(event) => {
        if (cropping) {
          const from = cropStart.current;
          const at = from ? fractionOf(event) : null;
          if (!from || !at) return;
          setRect({
            x: Math.min(from.x, at.x),
            y: Math.min(from.y, at.y),
            width: Math.abs(at.x - from.x),
            height: Math.abs(at.y - from.y),
          });
          return;
        }
        move(event);
      }}
      onPointerUp={(event) => {
        if (cropping) {
          cropStart.current = null;
          return;
        }
        end();
        void event;
      }}
      onPointerCancel={end}
      /* Клик мимо картинки — тоже закрытие: это привычно и на десктопе
         быстрее, чем целиться в крестик. */
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="za-viewer__bar" onPointerDown={(event) => event.stopPropagation()}>
        {/* Размер картинки В ЗАМЕТКЕ (замечание 2): «−» и «+» ходят по шагам,
            «сброс» возвращает исходный. Кнопки прячутся, если менять нечего —
            у картинки по внешней ссылке в тексте размера нет. */}
        {onWidth ? (
          <div className="za-viewer__sizes">
            <button
              type="button"
              className="za-viewer__size"
              aria-label={strings.attachments.narrower}
              onClick={() => onWidth(stepWidth(width, -1))}
            >
              −
            </button>
            <button
              type="button"
              className="za-viewer__size"
              aria-label={strings.attachments.wider}
              onClick={() => onWidth(stepWidth(width, 1))}
            >
              +
            </button>
            {width !== null ? (
              <button
                type="button"
                className="za-viewer__size"
                onClick={() => onWidth(null)}
              >
                {strings.attachments.sizeReset}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Обрезка меняет сам файл, поэтому подтверждается отдельно. */}
        {onCrop ? (
          cropping ? (
            <div className="za-viewer__sizes">
              <button
                type="button"
                className="za-viewer__size"
                onClick={() => {
                  setCropping(false);
                  setRect(null);
                }}
              >
                {strings.app.cancel}
              </button>
              <button
                type="button"
                className="za-viewer__size za-viewer__size--accent"
                disabled={busy || rect === null || rect.width < 0.02 || rect.height < 0.02}
                onClick={() => {
                  if (!rect) return;
                  setBusy(true);
                  void onCrop(rect).then((ok) => {
                    setBusy(false);
                    if (!ok) return;
                    setCropping(false);
                    setRect(null);
                  });
                }}
              >
                {strings.attachments.cropApply}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="za-viewer__size"
              onClick={() => setCropping(true)}
            >
              {strings.attachments.crop}
            </button>
          )
        ) : null}

        <IconButton
          icon={<IconClose size={20} />}
          label={strings.app.close}
          tone="ghost"
          onClick={onClose}
        />
      </div>
      <div className="za-viewer__stage">
        <img
          ref={frame}
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
        {/* Рамка кадрирования поверх картинки. Долями, а не пикселями: так она
            остаётся верной при любом масштабе показа. */}
        {cropping && rect ? (
          <div
            className="za-viewer__crop"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.width * 100}%`,
              height: `${rect.height * 100}%`,
            }}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Следующий шаг ширины. `null` (свой размер) на шаг вниз даёт самый широкий
 * из списка: уменьшать «неизвестно от чего» бессмысленно, а вот сузить
 * большую картинку — обычное намерение.
 */
function stepWidth(current: number | null, direction: 1 | -1): number | null {
  if (current === null) return direction < 0 ? (WIDTHS[WIDTHS.length - 1] ?? null) : null;
  const index = WIDTHS.findIndex((value) => value >= current);
  const next = (index === -1 ? WIDTHS.length - 1 : index) + direction;
  if (next < 0) return WIDTHS[0] ?? null;
  /* За верхней границей — «свой размер»: шире списка картинку не растягиваем,
     это уже не масштаб, а растр в мыле. */
  if (next >= WIDTHS.length) return null;
  return WIDTHS[next] ?? null;
}
