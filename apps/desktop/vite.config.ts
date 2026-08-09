/**
 * Сборка фронтенда оболочки Windows.
 *
 * Фронтенд здесь — это ровно `src/main.tsx` плюс реализации платформенных
 * портов. Всё остальное приезжает пакетами `@zapiski/app`, `@zapiski/ui`,
 * `@zapiski/editor`, `@zapiski/core` (ARCHITECTURE §1).
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],

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
