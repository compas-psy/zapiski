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
 *                   работает — см. updater.ts).
 *
 * `null` означает «UI **скроет** элемент», а не «покажет выключенным»
 * (BEHAVIOR §5.1). Поэтому подделывать возможности нельзя ни при каких
 * обстоятельствах: скрытый тумблер честен, выключенный — обманывает.
 */
import type { PlatformCapabilities } from '@zapiski/core';

import { createBiometrics } from './biometrics';
import { createHaptics } from './haptics';
import { COMMANDS, call } from './ipc';
import { createShareTarget } from './share';
import { createUpdater } from './updater';
import { defaultVaultRoot, openVault } from './vault';

export function createPlatform(): PlatformCapabilities {
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
      // На Android «выбор папки» вырождается: произвольный каталог общей
      // памяти приложению недоступен (scoped storage), а SAF отдаёт дерево
      // `content://`, поверх которого нет ни атомарного rename, ни обычного
      // пути для Rust. Поэтому диалога нет — есть каталог приложения во
      // внешней памяти, настоящие файлы `.md` на настоящей ФС.
      //
      // Сценарий «мой vault в другой папке» на Android закрывается синком
      // (LocalFolder на компьютере ↔ облако ↔ телефон), а не выбором папки.
      const root = await defaultVaultRoot();
      return openVault(root);
    },
  };
}
