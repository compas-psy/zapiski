/**
 * Возможности платформы «веб» (ARCHITECTURE §2).
 *
 * Правило одно и жёсткое: чего у платформы нет — то `null`, и экран этот
 * элемент СКРЫВАЕТ, а не показывает выключенным (BEHAVIOR §5.1). Поэтому здесь
 * нет ни одной заглушки, которая делает вид, что умеет.
 */
import type { PlatformCapabilities, VaultStorage } from '@zapiski/core';
import { createWebAuthnBiometrics } from './biometrics.js';
import type { VaultOwner } from '@zapiski/core';
import { pickVaultDirectory } from './vault-storage.js';

export function createWebPlatform(): PlatformCapabilities {
  return {
    kind: 'web',
    version: __ZAPISKI_VERSION__,

    /** WebAuthn-PRF, если браузер и устройство умеют; иначе тумблера нет. */
    biometrics: createWebAuthnBiometrics(),

    /** Вибрации по контракту продукта — только Android (BEHAVIOR §0). */
    haptics: null,

    /** Глобальный хоткей поверх всех окон — только Windows. */
    globalHotkey: null,

    /** Приём «Поделиться» от ОС — только Android. */
    shareTarget: null,

    /** Обновление ставит браузер (service worker), отдельного порта нет. */
    updater: null,

    /**
     * FLAG_SECURE в вебе не существует: вкладку нельзя скрыть из превью задач.
     * Поэтому здесь честный no-op, а не имитация защиты. Само содержимое
     * расшифрованной заметки всё равно живёт только в памяти и стирается
     * автозамком при сворачивании (BEHAVIOR §5.3).
     */
    secureFlag(): void {
      /* нечего делать */
    },

    pickVaultDirectory(owner?: VaultOwner): Promise<VaultStorage | null> {
      return pickVaultDirectory(owner);
    },
  };
}
