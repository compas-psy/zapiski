/**
 * Порт `BiometricProvider` поверх Windows Hello.
 *
 * Вся работа с `KeyCredentialManager` и заворачиванием секрета в AES-GCM
 * живёт в Rust (`src-tauri/src/hello.rs`) — в JS не попадает ни ключ, ни
 * подпись. Здесь только вызовы команд.
 *
 * Честность важнее наличия галочки: если Windows Hello на машине не настроен,
 * `isAvailable()` вернёт `false`, а `PlatformCapabilities.biometrics` станет
 * `null` — и UI **скроет** тумблер биометрии, а не покажет его выключенным
 * (BEHAVIOR §5.1, ARCHITECTURE §2). Никакой имитации «биометрия прошла»
 * здесь нет и быть не может: без подписи Hello секрет не расшифровывается.
 */
import { invoke } from '@tauri-apps/api/core';
import type { BiometricProvider } from '@zapiski/core';

export class WindowsHello implements BiometricProvider {
  async isAvailable(): Promise<boolean> {
    /* Ошибка вызова — это тоже «недоступно»: лучше спрятать тумблер, чем
       предложить способ входа, который не сработает. */
    return invoke<boolean>('hello_available').catch(() => false);
  }

  async enroll(keyId: string, secret: Uint8Array): Promise<void> {
    await invoke('hello_enroll', { keyId, secret: Array.from(secret) });
  }

  async unlock(keyId: string): Promise<Uint8Array | null> {
    /* `null` — пользователь отменил проверку либо ключ Hello сменился.
       По BEHAVIOR §5.2 это не ошибка: остаётся ввод пароля. */
    const secret = await invoke<number[] | null>('hello_unlock', { keyId });
    return secret === null ? null : Uint8Array.from(secret);
  }

  async remove(keyId: string): Promise<void> {
    await invoke('hello_remove', { keyId });
  }
}

/**
 * Провайдер, если Hello действительно доступен, иначе `null`.
 *
 * Проверка делается один раз при старте, до монтирования приложения: контракт
 * `PlatformCapabilities.biometrics` — поле, а не функция, и «выяснится позже»
 * означало бы тумблер, который появляется через секунду после открытия
 * настроек.
 */
export async function createBiometrics(): Promise<BiometricProvider | null> {
  const hello = new WindowsHello();
  return (await hello.isAvailable()) ? hello : null;
}
