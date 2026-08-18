/**
 * Граница между панелями, за которую можно потянуть.
 *
 * ── Что просил заказчик ─────────────────────────────────────────────────────
 *
 * «Ширина блоков Меню, список заметок, редактор должна быть настраиваема
 * мышкой — навёл на границу, появился соответствующий стандартный курсор и при
 * клике и перетаскивании ширина меняется и запоминается».
 *
 * Отсюда три обязательства, и каждое проверяется:
 *   · курсор над границей — системный `col-resize`, а не «палец» и не стрелка;
 *   · ширина меняется во время перетаскивания, а не после отпускания;
 *   · пережившая перезапуск ширина — та, которую поставили.
 *
 * ── Почему указатель, а не мышь ─────────────────────────────────────────────
 *
 * `pointerdown` + `setPointerCapture` — единственный способ довести
 * перетаскивание до конца, когда указатель ушёл за пределы полоски: без
 * захвата события достаются тому, над чем он оказался, и панель «залипает» на
 * полпути. Тач сюда не приходит вовсе: границы есть только в многопанельных
 * раскладках, а они начинаются с 900 px.
 *
 * ── Почему запись в настройки только при отпускании ─────────────────────────
 *
 * Во время перетаскивания ширина живёт в состоянии экрана и применяется
 * переменной CSS. Писать в оформление на каждое движение указателя значит
 * писать в localStorage шестьдесят раз в секунду — и получить дёрганый
 * указатель на ровном месте.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

export interface PaneResizerProps {
  /** Нынешняя ширина панели слева от границы. */
  width: number;
  min: number;
  max: number;
  /** Ширина во время перетаскивания — экран применяет её сразу. */
  onPreview: (width: number) => void;
  /** Итоговая ширина: сюда пишут в настройки. */
  onCommit: (width: number) => void;
  /** Подпись для скринридера: какая именно граница. */
  label: string;
}

/** Шаг стрелками: столько же, сколько у большинства редакторов. */
const STEP = 16;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

export function PaneResizer({
  width,
  min,
  max,
  onPreview,
  onCommit,
  label,
}: PaneResizerProps): ReactNode {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const from = start.current;
    if (from === null) return;
    onPreview(clamp(from.width + (event.clientX - from.x), min, max));
  };

  const end = (event: PointerEvent<HTMLDivElement>): void => {
    const from = start.current;
    if (from === null) return;
    start.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(clamp(from.width + (event.clientX - from.x), min, max));
  };

  return (
    <div
      className={`za-resizer${dragging ? ' za-resizer--active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        /* Только основная кнопка: правая открывает меню, средняя — своё. */
        if (event.button !== 0) return;
        event.preventDefault();
        start.current = { x: event.clientX, width };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        /* Стрелки — не украшение: роль `separator` обещает клавиатуре ровно
           это, а мышь есть не у всех и не всегда. */
        const delta = event.key === 'ArrowLeft' ? -STEP : event.key === 'ArrowRight' ? STEP : 0;
        if (delta === 0) return;
        event.preventDefault();
        onCommit(clamp(width + delta, min, max));
      }}
    />
  );
}
