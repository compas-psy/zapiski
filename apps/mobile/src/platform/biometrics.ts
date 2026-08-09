/**
 * `BiometricProvider` — Android Keystore + BiometricPrompt.
 *
 * Как это устроено (подробности — в `android/.../Biometrics.kt`):
 *
 *   enroll  — в Keystore заводится AES-ключ с `setUserAuthenticationRequired`,
 *             им шифруется секрет, шифротекст ложится в приватный каталог
 *             приложения. Сам секрет Keystore не покидает открытым.
 *   unlock  — `BiometricPrompt` с `CryptoObject`; ключ становится пригоден к
 *             использованию только после успешной биометрии. Отмена
 *             пользователем — это `null`, а не ошибка (BEHAVIOR §5.2:
 *             «Отмена биометрии пользователем — не ошибка»).
 *
 * **Честность важнее галочки.** `isAvailable()` возвращает `true` только когда
 * на устройстве есть настроенная стойкая биометрия и API её поддерживает
 * (Android 9+). На всём остальном — `false`, и UI **скроет** тумблер
 * (BEHAVIOR §5.1). Ни одной имитации: провайдер, который «как бы» защищает
 * ключ, хуже отсутствующего — пользователь считает заметки защищёнными.
 */
import type { BiometricProvider } from '@zapiski/core';

import { COMMANDS, call } from './ipc';

export function createBiometrics(): BiometricProvider {
  return {
    async isAvailable() {
      try {
        return await call<boolean>(COMMANDS.biometricsAvailable);
      } catch {
        return false;
      }
    },

    async enroll(keyId, secret) {
      // Ошибку пробрасываем: `packages/app` включает тумблер только после
      // успешного enroll, иначе пользователь считал бы, что вход по отпечатку
      // настроен, а он бы не работал.
      await call<void>(COMMANDS.biometricsEnroll, {
        keyId,
        secret: Array.from(secret),
      });
    },

    async unlock(keyId) {
      const bytes = await call<number[] | null>(COMMANDS.biometricsUnlock, { keyId });
      return bytes === null ? null : Uint8Array.from(bytes);
    },

    async remove(keyId) {
      await call<void>(COMMANDS.biometricsRemove, { keyId });
    },
  };
}
