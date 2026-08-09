import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // CodeMirror-вьюхе нужен настоящий DOM: Range, Selection, MutationObserver.
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    // Перф-бюджеты (ARCHITECTURE §4) чувствительны к параллельной нагрузке.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
  },
});
