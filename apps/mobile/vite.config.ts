import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Сборка фронтенда Android-оболочки.
 *
 * Оболочка тонкая (ARCHITECTURE §1): здесь собирается ровно одна точка входа,
 * которая монтирует `<App/>` из `@zapiski/app`. Никаких своих экранов, поэтому
 * и конфиг короткий.
 *
 * Бюджеты ТЗ §6 — холодный старт <1.5 с и APK <30 МБ — задают три решения:
 *   * `target: 'chrome108'` — нижняя планка WebView, которую мы реально
 *     поддерживаем (см. `minSdkVersion` в tauri.conf.json). Транспиляция ниже
 *     раздувает бандл и замедляет разбор;
 *   * `sourcemap: false` в релизе — карты весят больше самого кода и в APK
 *     не нужны;
 *   * `assetsInlineLimit: 0` — шрифты и картинки лежат файлами, а не в base64
 *     внутри JS: иначе они парсятся как часть главного чанка на старте.
 */

// Tauri прокидывает адрес хоста для запуска на реальном устройстве
// (`tauri android dev --host`). На эмуляторе и в CI переменной нет.
const devHost = process.env['TAURI_DEV_HOST'];

export default defineConfig({
  plugins: [react()],

  // Vite «съедает» вывод, а нам нужны сообщения cargo при `tauri android dev`.
  clearScreen: false,

  server: {
    port: 5184,
    // Порт зашит в tauri.conf.json → если он занят, честнее упасть, чем молча
    // уехать на другой и показать белый экран в приложении.
    strictPort: true,
    ...(devHost === undefined
      ? {}
      : { host: devHost, hmr: { protocol: 'ws', host: devHost, port: 5185 } }),
    watch: {
      // Rust-часть пересобирает cargo, а не Vite.
      ignored: ['**/src-tauri/**', '**/android/**'],
    },
  },

  build: {
    target: 'chrome108',
    sourcemap: false,
    assetsInlineLimit: 0,
    // Минификация esbuild'ом: terser даёт ~2% размера ценой заметного времени
    // сборки, а бюджет APK у нас с большим запасом.
    minify: 'esbuild',
    outDir: 'dist',
    emptyOutDir: true,
  },

  // `import.meta.env` для оболочки: дев-сборка ходит в облако по другому URL.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
