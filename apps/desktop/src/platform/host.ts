/**
 * Сборка `AppHost` — всего, что приложение получает от Windows.
 *
 * Это единственное место оболочки, где что-то «решается», и решается здесь
 * ровно одно: какая реализация порта подставлена. Ни одного экрана, ни одной
 * кнопки, ни одной строки продуктовой логики (ARCHITECTURE §1).
 */
import { invoke } from '@tauri-apps/api/core';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import type { AppHost, AppIntent } from '@zapiski/app';
import { LOCAL_OWNER } from '@zapiski/core';
import type { Locale, VaultStorage } from '@zapiski/core';

import { onAuthCallback, takeInitialAuthCallback } from './auth';
import { createBiometrics } from './biometrics';
import { createCapabilities } from './capabilities';
import { vaultPathOf } from './vault-owner';
import { defaultHotkey, NativeGlobalHotkey } from './hotkey';
import { hostOs } from './os';
import { WebviewPdfRenderer } from './pdf';
import { NativePreferences, SHELL_PREF } from './prefs';
import { platformStrings, resolveShellLocale, type PlatformStrings } from './strings';
import { NativeUpdater } from './updater';
import { onOpenFile } from './tray';
import { currentVaultRoot, openVaultAt } from './vault';

/**
 * Намерения открыть `.md` (ассоциация файлов, ТЗ §5.4).
 *
 * Подписка на `onOpenFile` — первым же действием модуля, а не внутри
 * `createDesktopShell()`: путь может прийти раньше, чем React смонтируется и
 * позовёт `onIntent` (см. `main.tsx` — окно показывается уже после первого
 * кадра). Без буфера намерение холодного старта терялось бы молча.
 */
const pendingIntents: AppIntent[] = [];
let intentHandler: ((intent: AppIntent) => void) | null = null;

function dispatchIntent(intent: AppIntent): void {
  if (intentHandler) intentHandler(intent);
  else pendingIntents.push(intent);
}

void onOpenFile((paths) => {
  for (const path of paths) dispatchIntent({ kind: 'open-file', path });
});

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

  /* Чтения, которые нужны до первого кадра, — параллельно: холодный старт
     на Windows по ТЗ §6 обязан уложиться в 2 с.

     Система спрашивается первой и отдельно: от неё зависит умолчание
     хоткея (`Cmd` против `Ctrl`), и подставить сюда чужое значение значило бы
     занять на macOS сочетание, которого там никто не нажимает. */
  const os = await hostOs();
  const [biometrics, storedLocale, hotkeyAccelerator] = await Promise.all([
    createBiometrics(),
    prefs.get<string | null>(SHELL_PREF.locale, null),
    prefs.get<string>(SHELL_PREF.globalHotkey, defaultHotkey(os)),
  ]);

  const locale = resolveShellLocale(storedLocale);
  const strings = platformStrings(locale);
  const hotkey = new NativeGlobalHotkey();
  const updater = new NativeUpdater();

  const host: AppHost = {
    platform: createCapabilities({ os, prefs, strings, biometrics, globalHotkey: hotkey, updater }),

    async restoreVault(owner: string = LOCAL_OWNER): Promise<VaultStorage | null> {
      const stored = await vaultPathOf(prefs, owner);
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

    /**
     * Открыть вложение системным приложением (замечание 16).
     *
     * Windows нужен настоящий путь на диске: `blob:`-адрес, которым открытие
     * работало в вебе, системе бесполезен — по нему не откроется ни pdf, ни
     * docx. Корень хранилища знает оболочка, а приложение знает путь внутри
     * него; собираем здесь, потому что разделитель тоже свойство оболочки.
     */
    async openAttachment(path: string): Promise<boolean> {
      const root = await currentVaultRoot().catch(() => null);
      if (root === null) return false;
      const separator = root.includes('\\') ? '\\' : '/';
      const full = `${root}${root.endsWith(separator) ? '' : separator}${path.split('/').join(separator)}`;
      try {
        await openPath(full);
        return true;
      } catch {
        /* Нет приложения для такого типа файла, файл удалён, доступ закрыт —
           снаружи всё это одно и то же: открыть не вышло. Приложение
           попробует прежний путь. */
        return false;
      }
    },

    cloudBaseUrl: CLOUD_BASE_URL,

    /** Возврат после входа по `zapiski://` (см. `platform/auth.ts`). */
    takeInitialAuthCallback,
    onAuthCallback,

    /** Ассоциация `.md` (ТЗ §5.4) — путь уже мог прийти, см. буфер выше. */
    async takeInitialIntent(): Promise<AppIntent | null> {
      return pendingIntents.shift() ?? null;
    },
    onIntent(handler: (intent: AppIntent) => void): () => void {
      intentHandler = handler;
      while (pendingIntents.length > 0) handler(pendingIntents.shift()!);
      return () => {
        intentHandler = null;
      };
    },
    async readOpenedFile(path: string): Promise<Uint8Array | null> {
      const bytes = await invoke<number[] | null>('read_opened_file', { path });
      return bytes ? Uint8Array.from(bytes) : null;
    },

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
