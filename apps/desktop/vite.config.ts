/**
 * Сборка фронтенда оболочки Windows.
 *
 * Фронтенд здесь — это ровно `src/main.tsx` плюс реализации платформенных
 * портов. Всё остальное приезжает пакетами `@zapiski/app`, `@zapiski/ui`,
 * `@zapiski/editor`, `@zapiski/core` (ARCHITECTURE §1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  /* Версия сборки — в «О приложении» (1_Design.md §3.2, И6). Читается из
     package.json оболочки: у веба, установщика и apk свои номера, и подставить
     сюда версию монорепозитория значило бы показать не ту, что установлена. */
  define: {
    __ZAPISKI_VERSION__: JSON.stringify(
      (JSON.parse(readFileSync(here('./package.json'), 'utf8')) as { version: string }).version,
    ),
  },


  /* Логи Vite не затирают вывод `tauri dev`. */
  clearScreen: false,

  server: {
    /* Порт зафиксирован: тот же номер стоит в `tauri.conf.json` → devUrl.
       strictPort — чтобы Vite не уехал на 5184, оставив окно на пустом
       адресе. */
    port: 5183,
    strictPort: true,
    /* Наружу не слушаем: dev-сервер отдаёт исходники приложения. */
    host: false,
    watch: {
      /* Rust пересобирает cargo, Vite тут перезапускаться не должен. */
      ignored: ['**/src-tauri/**'],
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /* Единственный движок этой сборки — WebView2 (Chromium, evergreen).
       Даунлевелить до ES2015 незачем: лишний транспайл только раздувает
       бандл, а бюджет установщика — 25 МБ (ТЗ §6). */
    target: 'chrome110',
    minify: 'esbuild',
    /* Карты исходников не кладём в установщик: они больше самого бандла.
       Для отладки собирается дев-режим. */
    sourcemap: false,
  },

  /* `TAURI_ENV_*` прокидывает сам Tauri; префикс нужен, чтобы фронтенд мог
     их прочитать (например, платформу для эндпоинта обновлений). */
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
