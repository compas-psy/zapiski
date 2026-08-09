import '@testing-library/jest-dom/vitest';

/* jsdom не реализует matchMedia — без заглушки падает всё, что читает
   prefers-color-scheme / prefers-reduced-motion. Отдельные тесты
   переопределяют её на управляемую. */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
