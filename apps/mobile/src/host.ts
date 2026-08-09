/**
 * `AppHost` — всё, что приложение получает от Android. Больше ему ничего не
 * нужно (`packages/app/src/contract.ts`).
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppHost } from '@zapiski/app';

import { onAuthCallback, takeInitialAuthCallback } from './platform/auth';
import { createPlatform, PREF_SAF_TREE } from './platform/capabilities';
import { saveFile } from './platform/files';
import { createPdfRenderer } from './platform/pdf';
import { createPreferences } from './platform/prefs';
import { createSafStorage, probeSafTree } from './platform/saf';
import { currentVaultRoot, defaultVaultRoot, openVault } from './platform/vault';

/**
 * Дев-сборка ходит в облако по другому адресу — например, на ноутбук
 * разработчика в той же сети. Прод-значение зашито: адрес облака СИМПАС не
 * настраивается пользователем.
 */
// База ОБЯЗАНА включать префикс версии: приложение дописывает только путь
// ручки (см. AppHost.cloudBaseUrl). Без `/api/v1` вход уходил в 404.
const CLOUD_BASE_URL =
  (import.meta.env['VITE_CLOUD_BASE_URL'] as string | undefined) ??
  'https://zapiski.cmpas.ru/api/v1';

export function createHost(): AppHost {
  /* Настройки нужны и платформе: в них лежит выбранная папка (ТЗ §4.1 п. 1). */
  const prefs = createPreferences();

  return {
    platform: createPlatform(prefs),
    prefs,
    cloudBaseUrl: CLOUD_BASE_URL,

    // Печать есть: её делает системный конвейер Android (platform/pdf.ts),
    // поэтому пункт «PDF» в экспорте виден, а не скрыт.
    pdf: createPdfRenderer(),

    saveFile,

    /** Возврат после входа: `zapiski://` и App Links (см. `platform/auth.ts`). */
    takeInitialAuthCallback,
    onAuthCallback,

    /**
     * Где лежат заметки. Порядок такой:
     *
     *  1. папка, выбранная пользователем через SAF (ТЗ §4.1 п. 1) — если
     *     разрешение на неё ещё действует. Отозвали разрешение или удалили
     *     папку — молча падаем на умолчание, а не пишем в пустоту;
     *  2. каталог приложения — умолчание и надёжный путь с атомарной
     *     записью (ТЗ §4.3).
     *
     * `null` вернётся, только если и каталог приложения открыть не удалось —
     * например, внешняя память отключена. Тогда `packages/app` покажет
     * онбординг, а не пустой список: BEHAVIOR §11 «Папка недоступна…».
     */
    async restoreVault() {
      const tree = await prefs.get<string | null>(PREF_SAF_TREE, null);
      if (tree !== null) {
        const alive = await probeSafTree(tree).catch(() => null);
        if (alive) return createSafStorage(alive.uri);
        await prefs.set(PREF_SAF_TREE, null);
      }
      const known = await currentVaultRoot().catch(() => null);
      const root = known ?? (await defaultVaultRoot().catch(() => null));
      if (root === null) return null;
      return openVault(root);
    },

    async openExternal(url: string) {
      // Через системный обработчик: ссылка на ДНЕВНИК должна открыться
      // в его приложении, если оно установлено, а не в браузере.
      await openUrl(url);
    },
  };
}
