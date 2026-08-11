/**
 * Сборка `AppHost` — всего, что приложение получает от Windows.
 *
 * Это единственное место оболочки, где что-то «решается», и решается здесь
 * ровно одно: какая реализация порта подставлена. Ни одного экрана, ни одной
 * кнопки, ни одной строки продуктовой логики (ARCHITECTURE §1).
 */
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppHost } from '@zapiski/app';
import type { Locale, VaultStorage } from '@zapiski/core';

import { onAuthCallback, takeInitialAuthCallback } from './auth';
import { createBiometrics } from './biometrics';
import { createCapabilities } from './capabilities';
import { DEFAULT_HOTKEY, NativeGlobalHotkey } from './hotkey';
import { WebviewPdfRenderer } from './pdf';
import { NativePreferences, SHELL_PREF } from './prefs';
import { platformStrings, resolveShellLocale, type PlatformStrings } from './strings';
import { NativeUpdater } from './updater';
import { openVaultAt } from './vault';

/** Боевой ZapiskiCloud. В дев-режиме подменяется переменной окружения Vite. */
// База ОБЯЗАНА включать префикс версии: приложение дописывает только путь
// ручки (см. AppHost.cloudBaseUrl). Без `/api/v1` вход уходил в 404.
const CLOUD_BASE_URL =
  import.meta.env.VITE_CLOUD_BASE_URL ?? 'https://zapiski.cmpas.ru/api/v1';

export interface DesktopShell {
  host: AppHost;
  /**
   * Язык из настроек, иначе язык системы, иначе русский. Уезжает пропом в
   * `<App>`: контроллер приложения при старте читает из настроек всё, кроме
   * языка, — иначе выбранный язык сбрасывался бы на каждом запуске.
   */
  locale: Locale;
  /** Строки поверхностей ОС: трей и системные диалоги. */
  strings: PlatformStrings;
  /** Нужен точке входа, чтобы занять хоткей из настроек при старте. */
  hotkey: NativeGlobalHotkey;
  /** Сочетание из настроек (по умолчанию Ctrl+Alt+N). */
  hotkeyAccelerator: string;
  updater: NativeUpdater;
}

export async function createDesktopShell(): Promise<DesktopShell> {
  const prefs = new NativePreferences();

  /* Три чтения, которые нужны до первого кадра, — параллельно: холодный старт
     на Windows по ТЗ §6 обязан уложиться в 2 с. */
  const [biometrics, storedLocale, hotkeyAccelerator] = await Promise.all([
    createBiometrics(),
    prefs.get<string | null>(SHELL_PREF.locale, null),
    prefs.get<string>(SHELL_PREF.globalHotkey, DEFAULT_HOTKEY),
  ]);

  const locale = resolveShellLocale(storedLocale);
  const strings = platformStrings(locale);
  const hotkey = new NativeGlobalHotkey();
  const updater = new NativeUpdater();

  const host: AppHost = {
    platform: createCapabilities({ prefs, strings, biometrics, globalHotkey: hotkey, updater }),

    async restoreVault(): Promise<VaultStorage | null> {
      const stored = await prefs.get<string | null>(SHELL_PREF.vaultPath, null);
      if (stored === null) return null;
      try {
        return await openVaultAt(stored);
      } catch {
        /* Каталог переименовали, удалили или он лежит на отключённом диске.
           Это не ошибка приложения: `null` вернёт пользователя к выбору места
           хранения (SCREENS §1, шаг 2). */
        return null;
      }
    },

    prefs,

    async openExternal(url: string): Promise<void> {
      /* Именно системный браузер, а не окно вебвью: внешняя страница не
         должна исполняться в контексте приложения. */
      await openUrl(url);
    },

    cloudBaseUrl: CLOUD_BASE_URL,

    /** Возврат после входа по `zapiski://` (см. `platform/auth.ts`). */
    takeInitialAuthCallback,
    onAuthCallback,

    pdf: new WebviewPdfRenderer(),

    async saveFile(name: string, data: Uint8Array, _mime: string): Promise<void> {
      /* MIME здесь не нужен: Windows определяет тип по расширению, а оно уже
         в имени. Диалог открывает Rust — путь не проходит через вебвью
         (см. `src-tauri/src/save.rs`). Отмена пользователя — не ошибка. */
      await invoke('save_file', data, {
        headers: { 'x-save-name': encodeURIComponent(name) },
      });
    },
  };

  return { host, locale, strings, hotkey, hotkeyAccelerator, updater };
}
