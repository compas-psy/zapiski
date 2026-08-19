/**
 * Тесты веб-оболочки.
 *
 * Окружение — node: экранов в оболочке нет (ARCHITECTURE §1), а service
 * worker и подавно живёт без DOM. Настоящий `public/sw.js` поднимается в
 * поддельном окружении воркера — см. `test/service-worker.test.ts`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
