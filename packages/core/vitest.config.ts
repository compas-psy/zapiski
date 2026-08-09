import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Перф-тесты (ТЗ §6) чувствительны к параллельной нагрузке — гоняем в один поток.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      // contract.ts — только типы (владелец CTO), i18n — данные, index.ts — реэкспорты.
      exclude: ['src/contract.ts', 'src/index.ts', 'src/i18n/**'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
