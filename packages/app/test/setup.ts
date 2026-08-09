/**
 * Общая подготовка среды для тестов экранов.
 *
 * happy-dom даёт DOM и события, но не даёт `matchMedia` и не считает раскладку.
 * Оба пробела закрываем здесь — иначе каждый тест начинал бы с одной и той же
 * заглушки.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

interface MediaState {
  width: number;
  landscape: boolean;
  reducedMotion: boolean;
  dark: boolean;
}

const media: MediaState = { width: 1280, landscape: true, reducedMotion: false, dark: false };

/** Задать «экран» для теста раскладок (SCREENS «Каркас»). */
export function setViewport(width: number, landscape = width >= 600): void {
  media.width = width;
  media.landscape = landscape;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

/** `prefers-reduced-motion: reduce` — приёмочный критерий №9. */
export function setReducedMotion(on: boolean): void {
  media.reducedMotion = on;
}

function matches(query: string): boolean {
  if (query.includes('prefers-reduced-motion')) return media.reducedMotion;
  if (query.includes('prefers-color-scheme: dark')) return media.dark;
  if (query.includes('orientation: landscape')) return media.landscape;
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  if (min && media.width < Number(min[1])) return false;
  if (max && media.width > Number(max[1])) return false;
  return Boolean(min || max);
}

beforeEach(() => {
  media.width = 1280;
  media.landscape = true;
  media.reducedMotion = false;
  media.dark = false;

  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() {
      return matches(query);
    },
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number) as typeof requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) =>
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)) as typeof cancelAnimationFrame;
  }
});

afterEach(() => {
  /* Без globals:true автоочистка не подключается сама, а без неё соседние
     тесты видят разметку друг друга. */
  cleanup();
  vi.useRealTimers();
});
