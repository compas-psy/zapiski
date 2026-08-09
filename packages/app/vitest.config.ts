import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Тесты поведения экранов. Среда — happy-dom: экранам нужен DOM с событиями
 * указателя, но не нужен полноценный движок вёрстки.
 *
 * Пакеты воркспейса резолвятся в исходники — так тесты не зависят от того,
 * собран ли `dist` соседней команды (ARCHITECTURE §5: публичный API всё равно
 * берётся только через `src/index.ts`).
 */
const resolveSource = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@zapiski/core/contract': resolveSource('../core/src/contract.ts'),
      '@zapiski/core': resolveSource('../core/src/index.ts'),
      '@zapiski/editor': resolveSource('../editor/src/index.ts'),
      '@zapiski/ui': resolveSource('../ui/src/index.ts'),
    },
  },
  /* Тесты читают ТЗ из `docs/spec/` — корень воркспейса должен быть доступен. */
  server: {
    fs: { allow: [resolveSource('../..')] },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
});
