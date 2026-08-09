import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    // Один Postgres на прогон: файлы идут последовательно, чтобы тесты квоты
    // и лимитов не мешали друг другу через общий счётчик.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
  },
});
