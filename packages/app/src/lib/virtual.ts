/**
 * Виртуализация списка — BEHAVIOR §1.3.
 *
 * Включается при >100 элементов. Высота строки фиксирована для режима
 * плотности (74 обычная / 58 компактная) — поэтому скроллбар корректен без
 * измерения DOM, а скролл держит 60 fps на 10 000 заметок.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Порог включения виртуализации (BEHAVIOR §1.3). */
export const VIRTUALIZE_FROM = 100;
/** Высота строки: обычная / компактная (SCREENS §3). */
export const ROW_HEIGHT = 74;
export const ROW_HEIGHT_COMPACT = 58;
/** Догрузка — окно ±20 экранов… но в px это слишком много; берём запас строк. */
const OVERSCAN_ROWS = 20;

export interface VirtualWindow {
  /** Индекс первой отрисованной строки. */
  start: number;
  /** Индекс за последней отрисованной строкой. */
  end: number;
  /** Отступ сверху вместо неотрисованных строк. */
  padTop: number;
  /** Отступ снизу вместо неотрисованных строк. */
  padBottom: number;
  /** Виртуализация реально включена. */
  active: boolean;
  onScroll: (event: { currentTarget: { scrollTop: number; clientHeight: number } }) => void;
}

export function useVirtualWindow(count: number, rowHeight: number): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const frame = useRef<number | null>(null);

  const onScroll = useCallback(
    (event: { currentTarget: { scrollTop: number; clientHeight: number } }): void => {
      const { scrollTop: top, clientHeight } = event.currentTarget;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setScrollTop(top);
        setViewport(clientHeight);
      });
    },
    [],
  );

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const active = count > VIRTUALIZE_FROM;
  if (!active) {
    return { start: 0, end: count, padTop: 0, padBottom: 0, active: false, onScroll };
  }

  const visible = Math.ceil((viewport || rowHeight * 12) / rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const end = Math.min(count, start + visible + OVERSCAN_ROWS * 2);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
    active: true,
    onScroll,
  };
}
