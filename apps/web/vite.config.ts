/**
 * Сборка веб-оболочки.
 *
 * Приложение живёт по адресу https://zapiski.cmpas.ru, статика раскладывается
 * в `/var/www/zapiski.cmpas.ru`, API — на том же домене по пути `/api/v1`.
 * Поэтому `base` — корень домена: никаких префиксов пути в ссылках на ассеты.
 */
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * `themeInitScript` обязан стоять инлайном в `<head>` ДО стилей и до первого
 * кадра, иначе выбранная тема подменяется после гидратации (белая вспышка).
 *
 * Строку берём из публичного API `@zapiski/ui` — копии здесь нет и быть не
 * должно. Node сам импортировать пакет не может (в нём есть импорты `.css`),
 * поэтому собираем его esbuild'ом, заглушив стили: единственный экспорт,
 * который нам нужен, — константа, а всё остальное отсекает tree-shaking.
 */
async function readThemeInitScript(): Promise<string> {
  const bundled = await esbuild({
    stdin: {
      contents: "export { themeInitScript } from '@zapiski/ui';",
      resolveDir: here('.'),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'zapiski-stub-css',
        setup(builder) {
          builder.onResolve({ filter: /\.css$/ }, (args) => ({
            path: args.path,
            namespace: 'zapiski-stub-css',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'zapiski-stub-css' }, () => ({
            contents: '',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const code = bundled.outputFiles[0]?.text ?? '';
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )) as { themeInitScript: string };
  return module.themeInitScript;
}

function themeInitPlugin(script: string): Plugin {
  return {
    name: 'zapiski-theme-init',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => ({
        html,
        tags: [{ tag: 'script', injectTo: 'head-prepend', children: script }],
      }),
    },
  };
}

export default defineConfig(async () => ({
  /* Сборка едет в корень домена. */
  base: '/',
  plugins: [react(), themeInitPlugin(await readThemeInitScript())],
  resolve: {
    /* Пакеты воркспейса резолвятся в исходники: публичный API всё равно
       берётся только через `src/index.ts` (ARCHITECTURE §5). */
    alias: {
      '@zapiski/core/contract': here('../../packages/core/src/contract.ts'),
      '@zapiski/core': here('../../packages/core/src/index.ts'),
      '@zapiski/editor': here('../../packages/editor/src/index.ts'),
      '@zapiski/ui': here('../../packages/ui/src/index.ts'),
      '@zapiski/app': here('../../packages/app/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    /* Ассеты хешируются, поэтому service worker кэширует их навсегда. */
    assetsDir: 'assets',
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    /* В деве API проксируется на локальный сервер — путь тот же, что в проде. */
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
}));
