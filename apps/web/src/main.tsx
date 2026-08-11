/**
 * Точка входа веб-оболочки.
 *
 * Здесь нет ни одного экрана и ни одной кнопки — так и должно быть
 * (ARCHITECTURE §1). Файл делает ровно три вещи: собирает `AppHost` из
 * платформенных портов, монтирует `<App/>` и включает PWA-обвязку.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppHost } from '@zapiski/app';
import { API_PREFIX, resolveLocale } from '@zapiski/core';
import { armAuthCapture, onAuthCallback, takeInitialAuthCallback } from './auth.js';
import { createWebPlatform } from './platform.js';
import { createWebPreferences } from './prefs.js';
import { createPrintPdfRenderer, saveFile } from './pdf.js';
import { registerServiceWorker, syncThemeColor } from './pwa.js';
import { restoreVault } from './vault-storage.js';

/* Токен снимается с адреса до первого кадра — раньше, чем что-либо успеет
   его увидеть или сохранить (см. `auth.ts`). */
armAuthCapture();

const host: AppHost = {
  platform: createWebPlatform(),
  prefs: createWebPreferences(),
  restoreVault,

  /** Внешние ссылки — новой вкладкой. */
  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  /** API живёт на том же домене: `https://zapiski.cmpas.ru/api/v1`. */
  cloudBaseUrl: `${window.location.origin}${API_PREFIX}`,

  pdf: createPrintPdfRenderer(),
  saveFile,

  /** Возврат после входа: холодный старт и переход в уже открытую вкладку. */
  takeInitialAuthCallback,
  onAuthCallback,
};

const container = document.getElementById('root');
if (!container) throw new Error('Не найден #root: разметка оболочки повреждена');

registerServiceWorker();
syncThemeColor();

createRoot(container).render(
  <StrictMode>
    <App host={host} locale={resolveLocale(navigator.languages ?? [navigator.language])} />
  </StrictMode>,
);
