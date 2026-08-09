/**
 * Жесты списка — BEHAVIOR §1.1 и §1.4.
 *
 * Главное здесь — приёмочный критерий №4: свайп, отпущенный ДО порога, не
 * выполняет действие никогда.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  PULL_TO_SEARCH_PX,
  SWIPE_THRESHOLD_PX,
  useLongPress,
  usePull,
  useSwipe,
} from '../src/lib/gestures.js';

/** Событие указателя достаточной полноты — хук читает только эти поля. */
function pointer(x: number, y = 0, time = 0): ReactPointerEvent<HTMLElement> {
  return {
    clientX: x,
    clientY: y,
    timeStamp: time,
    pointerId: 1,
    pointerType: 'touch',
    currentTarget: { setPointerCapture: () => {} },
  } as unknown as ReactPointerEvent<HTMLElement>;
}

function swipe(
  result: { current: ReturnType<typeof useSwipe> },
  distance: number,
  durationMs = 400,
): void {
  /* Обработчики берём заново на каждом шаге: между событиями указателя React
     успевает перерисоваться, и в браузере элемент тоже получает свежие. */
  act(() => result.current.handlers.onPointerDown(pointer(0, 0, 0)));
  /* Первый шаг задаёт ось жеста, дальше — смещение по X. */
  act(() =>
    result.current.handlers.onPointerMove(pointer(Math.sign(distance) * 10, 0, durationMs / 2)),
  );
  act(() => result.current.handlers.onPointerMove(pointer(distance, 0, durationMs)));
  act(() => result.current.handlers.onPointerUp(pointer(distance, 0, durationMs)));
}

describe('свайп по строке списка', () => {
  it('порог — ровно 96 px (BEHAVIOR §1.1)', () => {
    expect(SWIPE_THRESHOLD_PX).toBe(96);
  });

  it('отпускание ДО порога не делает ничего — приёмочный критерий №4', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const { result } = renderHook(() => useSwipe({ onLeft, onRight }));

    swipe(result, SWIPE_THRESHOLD_PX - 1);
    swipe(result, -(SWIPE_THRESHOLD_PX - 1));

    expect(onRight).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
    /* Строка вернулась на место. */
    expect(result.current.offset).toBe(0);
  });

  it('за порогом вправо — закрепление, влево — архив', () => {
    const onLeft = vi.fn();
    const onRight = vi.fn();
    const { result } = renderHook(() => useSwipe({ onLeft, onRight }));

    swipe(result, SWIPE_THRESHOLD_PX);
    expect(onRight).toHaveBeenCalledTimes(1);
    expect(onLeft).not.toHaveBeenCalled();

    swipe(result, -SWIPE_THRESHOLD_PX);
    expect(onLeft).toHaveBeenCalledTimes(1);
  });

  it('быстрый бросок срабатывает и не дойдя до порога (скорость >0.8 px/мс)', () => {
    const onRight = vi.fn();
    const { result } = renderHook(() => useSwipe({ onRight }));
    /* 60 px за 20 мс — 3 px/мс. */
    swipe(result, 60, 20);
    expect(onRight).toHaveBeenCalledTimes(1);
  });

  it('подложка проявляется пропорционально смещению на отрезке 0…96', () => {
    const { result } = renderHook(() => useSwipe({ onRight: () => {} }));
    const { handlers } = result.current;
    act(() => handlers.onPointerDown(pointer(0, 0, 0)));
    act(() => handlers.onPointerMove(pointer(10, 0, 10)));
    act(() => handlers.onPointerMove(pointer(48, 0, 200)));
    expect(result.current.reveal).toBeCloseTo(0.5, 2);
    expect(result.current.armed).toBe(false);
  });

  it('жест не работает, если направление не задано', () => {
    const onLeft = vi.fn();
    const { result } = renderHook(() => useSwipe({ onLeft }));
    swipe(result, SWIPE_THRESHOLD_PX + 20);
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('мышью строку не свайпают — на desktop есть меню и хоткеи', () => {
    const onRight = vi.fn();
    const { result } = renderHook(() => useSwipe({ onRight }));
    const mouse = { ...pointer(0), pointerType: 'mouse' } as ReactPointerEvent<HTMLElement>;
    act(() => result.current.handlers.onPointerDown(mouse));
    act(() => result.current.handlers.onPointerMove(pointer(200, 0, 100)));
    act(() => result.current.handlers.onPointerUp(pointer(200, 0, 100)));
    expect(onRight).not.toHaveBeenCalled();
  });
});

describe('long-press', () => {
  it('меню открывается через 500 мс, раньше — нет', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(pointer(0)));
    act(() => void vi.advanceTimersByTime(499));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('отпускание раньше отменяет', () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(pointer(0)));
    act(() => result.current.onPointerUp());
    act(() => void vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

describe('pull-to-search (BEHAVIOR §1.4)', () => {
  const touch = (y: number, fingers = 1): never =>
    ({
      currentTarget: { scrollTop: 0 },
      touches: Array.from({ length: fingers }, () => ({ clientY: y })),
    }) as never;

  it('оттягивание меньше 64 px возвращает список и ничего не открывает', () => {
    const onPullToSearch = vi.fn();
    const onPullToRefresh = vi.fn();
    const { result } = renderHook(() => usePull({ onPullToSearch, onPullToRefresh }));
    act(() => result.current.handlers.onTouchStart(touch(0)));
    act(() => result.current.handlers.onTouchMove(touch(PULL_TO_SEARCH_PX - 1)));
    act(() => result.current.handlers.onTouchEnd());
    expect(onPullToSearch).not.toHaveBeenCalled();
  });

  it('за порогом одним пальцем — поиск, двумя — принудительный синк', () => {
    const onPullToSearch = vi.fn();
    const onPullToRefresh = vi.fn();
    const { result } = renderHook(() => usePull({ onPullToSearch, onPullToRefresh }));

    act(() => result.current.handlers.onTouchStart(touch(0)));
    act(() => result.current.handlers.onTouchMove(touch(PULL_TO_SEARCH_PX + 10)));
    act(() => result.current.handlers.onTouchEnd());
    expect(onPullToSearch).toHaveBeenCalledTimes(1);

    act(() => result.current.handlers.onTouchStart(touch(0, 2)));
    act(() => result.current.handlers.onTouchMove(touch(PULL_TO_SEARCH_PX + 10, 2)));
    act(() => result.current.handlers.onTouchEnd());
    expect(onPullToRefresh).toHaveBeenCalledTimes(1);
  });

  it('во время синка жест выключен', () => {
    const onPullToSearch = vi.fn();
    const { result } = renderHook(() =>
      usePull({ onPullToSearch, onPullToRefresh: () => {}, disabled: true }),
    );
    act(() => result.current.handlers.onTouchStart(touch(0)));
    act(() => result.current.handlers.onTouchMove(touch(PULL_TO_SEARCH_PX + 40)));
    act(() => result.current.handlers.onTouchEnd());
    expect(onPullToSearch).not.toHaveBeenCalled();
  });
});
