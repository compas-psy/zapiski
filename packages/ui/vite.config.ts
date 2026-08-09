import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Конфиг только для витрины (`pnpm --filter @zapiski/ui gallery`). */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-gallery',
    rollupOptions: { input: 'gallery.html' },
  },
});
