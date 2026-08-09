/**
 * Жесты списка — BEHAVIOR §1.1, §1.4 и §7 (карта mobile-жестов).
 *
 * Здесь ровно та механика, которую проверяют на приёмке:
 *  • порог 96 px ИЛИ скорость >0.8 px/мс;
 *  • до порога подложка проявляется пропорционально смещению (opacity 0→1);
 *  • отпускание до порога — возврат 200 мс и НИЧЕГО не происходит
 *    (приёмочный критерий №4);
 *  • ТП на срабатывании — лёгкая (BEHAVIOR §0).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';
import type { HapticStrength } from '@zapiski/core';

/** Порог срабатывания свайпа, px (BEHAVIOR §1.1). */
export const SWIPE_THRESHOLD_PX = 96;
/** Альтернативный порог — скорость, px/мс (BEHAVIOR §1.1). */
export const SWIPE_VELOCITY_PX_PER_MS = 0.8;
/** Дальше порога строка не уезжает — иначе жест выглядит бесконечным. */
const SWIPE_MAX_PX = 132;
/** Оттягивание списка вниз, после которого открывается поиск (BEHAVIOR §1.4). */
export const PULL_TO_SEARCH_PX = 64;
/** Долгое нажатие (BEHAVIOR §1.1). */
export const LONG_PRESS_MS = 500;

export type Haptic = (strength: HapticStrength) => void;

export interface SwipeConfig {
  /** Свайп вправо: закрепить/открепить. Не задан — жест вправо не работает. */
  onRight?: (() => void) | undefined;
  /** Свайп влево: в архив / вернуть из архива. */
  onLeft?: (() => void) | undefined;
  haptic?: Haptic | undefined;
  disabled?: boolean | undefined;
}

export interface SwipeState {
  /** Текущее смещение строки, px. Отрицательное — влево. */
  offset: number;
  /** 0→1 пропорционально |offset| на отрезке 0…96 — прозрачность подложки. */
  reveal: number;
  /** Порог пройден: иконка зафиксирована, ТП уже была. */
  armed: boolean;
  /** Идёт ли возврат — на нём включается переход 200 мс. */
  releasing: boolean;
}

export interface SwipeHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

interface Origin {
  x: number;
  y: number;
  time: number;
  axis: 'none' | 'x' | 'y';
}

/**
 * Свайп по строке списка. Возвращает состояние для отрисовки и обработчики.
 *
 * Действие вызывается ТОЛЬКО если на момент отпускания пройден порог смещения
 * либо порог скорости. Это и есть приёмочный критерий №4.
 */
export function useSwipe(config: SwipeConfig): SwipeState & { handlers: SwipeHandlers } {
  const [offset, setOffset] = useState(0);
  const [releasing, setReleasing] = useState(false);
  const origin = useRef<Origin | null>(null);
  const armedRef = useRef(false);
  const lastMove = useRef<{ x: number; time: number } | null>(null);
  const velocity = useRef(0);

  const enabled = !config.disabled && (Boolean(config.onRight) || Boolean(config.onLeft));

  const reset = useCallback(() => {
    origin.current = null;
    lastMove.current = null;
    armedRef.current = false;
    velocity.current = 0;
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (!enabled) return;
      /* Мышью строку не свайпают: на desktop есть контекстное меню и хоткеи. */
      if (event.pointerType === 'mouse') return;
      origin.current = { x: event.clientX, y: event.clientY, time: event.timeStamp, axis: 'none' };
      lastMove.current = { x: event.clientX, time: event.timeStamp };
      velocity.current = 0;
      armedRef.current = false;
      setReleasing(false);
    },
    [enabled],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const start = origin.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;

      if (start.axis === 'none') {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        start.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (start.axis === 'x' && event.currentTarget.setPointerCapture) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      if (start.axis !== 'x') return;

      const previous = lastMove.current;
      if (previous) {
        const dt = Math.max(1, event.timeStamp - previous.time);
        velocity.current = (event.clientX - previous.x) / dt;
      }
      lastMove.current = { x: event.clientX, time: event.timeStamp };

      const allowed = dx > 0 ? Boolean(config.onRight) : Boolean(config.onLeft);
      const next = allowed ? Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, dx)) : 0;

      /* Порог пройден впервые — фиксируем иконку и даём лёгкую ТП (BEHAVIOR §0). */
      const crossed = Math.abs(next) >= SWIPE_THRESHOLD_PX;
      if (crossed && !armedRef.current) {
        armedRef.current = true;
        config.haptic?.('light');
      } else if (!crossed) {
        armedRef.current = false;
      }
      setOffset(next);
    },
    [config],
  );

  const finish = useCallback((): void => {
    const start = origin.current;
    const current = offset;
    const speed = velocity.current;
    reset();
    setOffset(0);
    setReleasing(true);
    if (!start || start.axis !== 'x' || current === 0) return;

    const direction = current > 0 ? 1 : -1;
    const passedDistance = Math.abs(current) >= SWIPE_THRESHOLD_PX;
    const passedVelocity =
      Math.abs(speed) > SWIPE_VELOCITY_PX_PER_MS && Math.sign(speed) === direction;
    /* Ни расстояния, ни скорости — возврат 200 мс, действия нет. */
    if (!passedDistance && !passedVelocity) return;

    if (direction > 0) config.onRight?.();
    else config.onLeft?.();
  }, [config, offset, reset]);

  const handlers = useMemo<SwipeHandlers>(
    () => ({
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    }),
    [onPointerDown, onPointerMove, finish],
  );

  return {
    offset,
    reveal: Math.min(1, Math.abs(offset) / SWIPE_THRESHOLD_PX),
    armed: Math.abs(offset) >= SWIPE_THRESHOLD_PX,
    releasing,
    handlers,
  };
}

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
}

/** Long-press 500 мс → ТП + контекстное меню (BEHAVIOR §1.1). */
export function useLongPress(
  onLongPress: () => void,
  haptic?: Haptic | undefined,
): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  return useMemo<LongPressHandlers>(
    () => ({
      onPointerDown: () => {
        cancel();
        timer.current = setTimeout(() => {
          timer.current = null;
          haptic?.('light');
          onLongPress();
        }, LONG_PRESS_MS);
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      /* На desktop правая кнопка мыши — тот же жест, без ожидания. */
      onContextMenu: (event) => {
        event.preventDefault();
        cancel();
        onLongPress();
      },
    }),
    [cancel, haptic, onLongPress],
  );
}

export interface PullConfig {
  /** Оттягивание одним пальцем >64 px в позиции скролла 0 — открыть поиск. */
  onPullToSearch: () => void;
  /** Оттягивание двумя пальцами — принудительный синк (BEHAVIOR §7). */
  onPullToRefresh: () => void;
  /** Жест отключён, когда идёт синк-обновление списка (BEHAVIOR §1.4). */
  disabled?: boolean | undefined;
}

export interface PullState {
  /** 0→1: насколько проявилось поле поиска до порога. */
  progress: number;
  handlers: {
    onTouchStart: (event: ReactTouchEvent<HTMLElement>) => void;
    onTouchMove: (event: ReactTouchEvent<HTMLElement>) => void;
    onTouchEnd: () => void;
  };
}

/** Pull-to-search и pull-to-refresh двумя пальцами (BEHAVIOR §1.4, §7). */
export function usePull(config: PullConfig): PullState {
  const [progress, setProgress] = useState(0);
  const start = useRef<{ y: number; fingers: number } | null>(null);

  const onTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLElement>): void => {
      if (config.disabled) return;
      const target = event.currentTarget;
      if (target.scrollTop > 0) return;
      const touch = event.touches[0];
      if (!touch) return;
      start.current = { y: touch.clientY, fingers: event.touches.length };
    },
    [config.disabled],
  );

  const onTouchMove = useCallback((event: ReactTouchEvent<HTMLElement>): void => {
    const origin = start.current;
    const touch = event.touches[0];
    if (!origin || !touch) return;
    origin.fingers = Math.max(origin.fingers, event.touches.length);
    const delta = touch.clientY - origin.y;
    if (delta <= 0) {
      setProgress(0);
      return;
    }
    setProgress(Math.min(1, delta / PULL_TO_SEARCH_PX));
  }, []);

  const onTouchEnd = useCallback((): void => {
    const origin = start.current;
    const reached = progress >= 1;
    start.current = null;
    setProgress(0);
    if (!origin || !reached) return;
    if (origin.fingers >= 2) config.onPullToRefresh();
    else config.onPullToSearch();
  }, [config, progress]);

  return {
    progress,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
