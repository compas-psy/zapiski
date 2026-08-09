/**
 * `PlatformCapabilities` для Android — единственное место, где эта платформа
 * отличается от Windows и веба.
 *
 * Что есть и чего нет:
 *
 *   biometrics    — Android Keystore + BiometricPrompt (см. biometrics.ts);
 *   haptics       — есть, единственная из трёх платформ (BEHAVIOR §0);
 *   globalHotkey  — `null`. Глобального хоткея на Android не существует:
 *                   у платформы нет ни системных акселераторов для приложений,
 *                   ни фонового слушателя клавиатуры. Эквивалент быстрой
 *                   заметки — плитка Quick Settings и виджет 1×1 (§8);
 *   shareTarget   — есть, `intent-filter` ACTION_SEND;
 *   updater       — есть, свой (встроенный апдейтер Tauri на Android не
 *                   работает — см. updater.ts);
 *   vaultFolders  — есть, и только здесь: на Android выбор папки идёт с
 *                   оговоркой про атомарность записи (см. ниже).
 *
 * `null` означает «UI **скроет** элемент», а не «покажет выключенным»
 * (BEHAVIOR §5.1). Поэтому подделывать возможности нельзя ни при каких
 * обстоятельствах: скрытый тумблер честен, выключенный — обманывает.
 */
import type { PlatformCapabilities, VaultLocation, VaultLocationInfo } from '@zapiski/core';
import type { PreferencesStore } from '@zapiski/app';

import { createBiometrics } from './biometrics';
import { createHaptics } from './haptics';
import { COMMANDS, call } from './ipc';
import { createSafStorage, pickSafTree, probeSafTree, writeModeOf, type SafTree } from './saf';
import { createShareTarget } from './share';
import { createUpdater } from './updater';
import { defaultVaultRoot, openVault } from './vault';

/**
 * Дерево SAF, выбранное пользователем. Лежит в настройках рядом с остальным:
 * это не секрет, а адрес папки, и он обязан пережить перезапуск — иначе
 * заметки «пропадут» вместе с выбором.
 */
export const PREF_SAF_TREE = 'storage.androidTree';

/** Имя каталога приложения в интерфейсе — не путь: путь пользователю не нужен. */
const APP_FOLDER_LABEL = 'Записки';

function safLocation(tree: SafTree): VaultLocation {
  return {
    kind: 'user',
    writeMode: writeModeOf(tree),
    label: tree.label,
    storage: createSafStorage(tree.uri),
  };
}

export function createPlatform(prefs: PreferencesStore): PlatformCapabilities {
  /** Каталог приложения: настоящие `.md`, запись атомарна (ТЗ §4.3). */
  const openAppFolder = async (): Promise<VaultLocation | null> => {
    const root = await defaultVaultRoot();
    const storage = await openVault(root);
    if (!storage) return null;
    return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL, storage };
  };

  return {
    kind: 'android',
    biometrics: createBiometrics(),
    haptics: createHaptics(),
    globalHotkey: null,
    shareTarget: createShareTarget(),
    updater: createUpdater(),

    secureFlag(on: boolean): void {
      // Настоящий FLAG_SECURE окна (BEHAVIOR §5.3, приёмочный критерий №7):
      // содержимое не попадает ни в превью задач, ни в скриншот.
      // Порт синхронный, вызов — нет; ошибку глотаем, потому что показывать
      // её некуда и незачем: пользователь в этот момент сворачивает окно.
      void call<void>(COMMANDS.secureFlag, { on }).catch(() => undefined);
    },

    async pickVaultDirectory() {
      // Умолчание и надёжный путь: каталог приложения во внешней памяти —
      // настоящие файлы `.md` на настоящей ФС с атомарной записью. Выбор
      // произвольной папки живёт в `vaultFolders` и идёт с предупреждением:
      // смешивать их в одну кнопку значило бы обещать §4.3 там, где его нет.
      const location = await openAppFolder();
      return location?.storage ?? null;
    },

    /**
     * Выбор произвольной папки (ТЗ §4.1 п. 1: «LocalFolder — в т.ч. папка,
     * которую синкает сторонний клиент»).
     *
     * Раньше этого выбора не было вовсе: SAF не даёт атомарной записи, и мы
     * решали за пользователя. Цена оказалась выше пользы — на Android
     * закрывался весь бесплатный сценарий синхронизации через чужой клиент.
     * Теперь решает пользователь, а мы честно говорим, чем он платит.
     */
    vaultFolders: {
      async chooseFolder() {
        const tree = await pickSafTree();
        if (!tree) return null;
        await prefs.set(PREF_SAF_TREE, tree.uri);
        return safLocation(tree);
      },

      async useAppFolder() {
        await prefs.set(PREF_SAF_TREE, null);
        return openAppFolder();
      },

      async current(): Promise<VaultLocationInfo | null> {
        const uri = await prefs.get<string | null>(PREF_SAF_TREE, null);
        if (uri === null) {
          return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL };
        }
        const tree = await probeSafTree(uri).catch(() => null);
        if (!tree) {
          // Разрешение на папку отозвано или папка удалена: возвращаемся в
          // каталог приложения, а не делаем вид, что всё на месте.
          await prefs.set(PREF_SAF_TREE, null);
          return { kind: 'app', writeMode: 'atomic', label: APP_FOLDER_LABEL };
        }
        return { kind: 'user', writeMode: writeModeOf(tree), label: tree.label };
      },
    },
  };
}
