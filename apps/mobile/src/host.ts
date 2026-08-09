/**
 * `AppHost` — всё, что приложение получает от Android. Больше ему ничего не
 * нужно (`packages/app/src/contract.ts`).
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppHost } from '@zapiski/app';

import { createPlatform } from './platform/capabilities';
import { saveFile } from './platform/files';
import { createPdfRenderer } from './platform/pdf';
import { createPreferences } from './platform/prefs';
import { currentVaultRoot, defaultVaultRoot, openVault } from './platform/vault';

/**
 * Дев-сборка ходит в облако по другому адресу — например, на ноутбук
 * разработчика в той же сети. Прод-значение зашито: адрес облака КОМПАС не
 * настраивается пользователем.
 */
// База ОБЯЗАНА включать префикс версии: приложение дописывает только путь
// ручки (см. AppHost.cloudBaseUrl). Без `/api/v1` вход уходил в 404.
const CLOUD_BASE_URL =
  (import.meta.env['VITE_CLOUD_BASE_URL'] as string | undefined) ??
  'https://zapiski.cmpas.ru/api/v1';

export function createHost(): AppHost {
  return {
    platform: createPlatform(),
    prefs: createPreferences(),
    cloudBaseUrl: CLOUD_BASE_URL,

    // Печать есть: её делает системный конвейер Android (platform/pdf.ts),
    // поэтому пункт «PDF» в экспорте виден, а не скрыт.
    pdf: createPdfRenderer(),

    saveFile,

    /**
     * На Android vault ровно один и лежит в каталоге приложения, поэтому
     * восстановление всегда удаётся: онбординг с выбором места хранения на
     * этой платформе не нужен — там нечего выбирать (см. `pickVaultDirectory`).
     *
     * `null` вернётся только если каталог не удалось создать или открыть —
     * например, внешняя память отключена. Тогда `packages/app` покажет
     * онбординг, а не пустой список: BEHAVIOR §11 «Папка недоступна…».
     */
    async restoreVault() {
      const known = await currentVaultRoot().catch(() => null);
      const root = known ?? (await defaultVaultRoot().catch(() => null));
      if (root === null) return null;
      return openVault(root);
    },

    async openExternal(url: string) {
      // Через системный обработчик: ссылка на КОМПАС.Дневник должна открыться
      // в его приложении, если оно установлено, а не в браузере.
      await openUrl(url);
    },
  };
}
