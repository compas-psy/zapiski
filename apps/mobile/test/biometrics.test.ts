/**
 * Биометрия Android: три правила, каждое куплено отказом на устройстве.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «в андроиде при включении биометрии приложение просто крашится».
 * Ни тоста, ни строки в обратной связи — потому что показать их было уже
 * некому: процесс умирал. Разбор по исходникам дал три независимых дефекта,
 * складывавшихся в один симптом.
 *
 *  1. **Разрешения `USE_BIOMETRIC` в манифесте не было.** И `authenticate()`,
 *     и `canAuthenticate()` помечены `@RequiresPermission(USE_BIOMETRIC)`;
 *     без строки в манифесте система отвечает `SecurityException`.
 *  2. **Диалог показывался на главном потоке без страховки.** Тело
 *     `activity.runOnUiThread { … }` выполняется уже ПОСЛЕ того, как
 *     `enroll`/`unlock` вышли из своего `try`, — значит любое исключение оттуда
 *     необработанное, то есть смерть процесса.
 *  3. **Порт биометрии заявлялся всегда.** `PlatformCapabilities.biometrics` —
 *     поле, по которому интерфейс решает, показывать ли тумблер. На Android оно
 *     было непустым на любом устройстве, и лист шифрования предлагал отпечаток
 *     там, где стойкой биометрии нет вовсе (на Windows порт с самого начала
 *     `null`, если Hello не настроен).
 *
 * Модульным тестам продукта это недоступно: Kotlin они не видят, манифеста не
 * читают, а `BiometricPrompt` не существует ни в happy-dom, ни в браузере.
 * Поэтому здесь сторожатся сами ПРАВИЛА — по исходникам.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');

const KOTLIN = readFileSync(
  join(MOBILE, 'android/app/src/main/java/ru/cmpas/zapiski/Biometrics.kt'),
  'utf8',
);

describe('манифест пускает нас к диалогу биометрии', () => {
  it('патч добавляет USE_BIOMETRIC и не требует сканера обязательным', async () => {
    const { patchManifest } = await import('../scripts/apply-android-overlay.mjs');
    const fixture = readFileSync(
      join(MOBILE, 'scripts/fixtures/AndroidManifest.generated.xml'),
      'utf8',
    );

    const patched = patchManifest(fixture);

    expect(patched, 'без USE_BIOMETRIC диалог отвечает SecurityException').toContain(
      'android:name="android.permission.USE_BIOMETRIC"',
    );
    /* Android 9: `BiometricManager` там ещё нет, честный ответ даёт
       `FingerprintManager` — и требует своё, уже устаревшее разрешение. */
    expect(patched).toContain('android:name="android.permission.USE_FINGERPRINT"');
    /*
     * `required="false"` — не формальность: с `true` Play спрятал бы приложение
     * от планшетов без сканера, хотя шифрование там работает паролем и ничего
     * не теряет.
     */
    expect(patched).toContain(
      '<uses-feature android:name="android.hardware.fingerprint" android:required="false" />',
    );
  });
});

describe('диалог биометрии не уносит с собой приложение', () => {
  /**
   * Проверяется структура, а не текст: между входом в главный поток и первым
   * системным вызовом обязан стоять `try`, и у блока обязан быть `catch`,
   * отвечающий Rust'у. Иначе исключение остаётся необработанным на главном
   * потоке — а это и есть краш, с которым пришёл заказчик.
   */
  it('тело runOnUiThread обёрнуто в try/catch с ответом наружу', () => {
    const entry = KOTLIN.indexOf('activity.runOnUiThread {');
    expect(entry, 'блок главного потока пропал — перечитайте этот тест').toBeGreaterThan(0);

    const systemCall = KOTLIN.indexOf('BiometricPrompt.Builder(', entry);
    expect(systemCall).toBeGreaterThan(entry);

    const preamble = KOTLIN.slice(entry, systemCall);
    expect(preamble, 'системный диалог собирается вне try — исключение убьёт процесс').toContain(
      'try {',
    );

    const body = KOTLIN.slice(entry);
    expect(body, 'у блока главного потока нет catch').toMatch(/catch \(error: Throwable\)/);
    expect(body, 'отказ никому не сообщается').toContain('failed(error)');
  });

  it('колбэки системы тоже не выпускают исключение наружу', () => {
    /* `onAuthenticationSucceeded` и `onAuthenticationError` приходят на главный
       поток через `mainExecutor` — и подчиняются тому же правилу. */
    expect(KOTLIN).toContain('val deliver = { authenticated: Cipher? ->');
    /* Три места, откуда система возвращает управление: кнопка «Ввести пароль»,
       успех и ошибка. Все три обязаны идти через страховку. */
    expect(KOTLIN.match(/deliver\(/g)?.length ?? 0).toBe(3);
    expect(
      KOTLIN.includes('done(result.cryptoObject?.cipher)'),
      'колбэк зовёт `done` напрямую, минуя страховку',
    ).toBe(false);
  });

  it('отказ называет класс исключения, а не только «недоступна»', () => {
    /* На телефоне logcat человеку недоступен: без класса исключения починить
       отказ нечем — «биометрия недоступна» одинаково для SecurityException и
       для IllegalStateException. */
    expect(KOTLIN).toContain('error.javaClass.simpleName');
  });
});

describe('порт биометрии обещает только то, что есть', () => {
  /** IPC подменяется целиком: настоящий мост живёт только на устройстве. */
  async function loadPort(available: boolean | Error) {
    vi.resetModules();
    vi.doMock('../src/platform/ipc', () => ({
      COMMANDS: { biometricsAvailable: 'biometrics_available' },
      call: async () => {
        if (available instanceof Error) throw available;
        return available;
      },
    }));
    const { createBiometrics } = await import('../src/platform/biometrics');
    return createBiometrics();
  }

  it('устройство умеет — порт есть', async () => {
    expect(await loadPort(true)).not.toBeNull();
  });

  it('устройство не умеет — порт null, а не «пустой провайдер»', async () => {
    /*
     * Именно это и было сломано: порт возвращался всегда, и лист шифрования,
     * который смотрит на его НАЛИЧИЕ, показывал тумблер на любом телефоне.
     * `null` означает «интерфейс скроет элемент» (BEHAVIOR §5.1) — скрытый
     * тумблер честен, показанный обманывает.
     */
    expect(await loadPort(false)).toBeNull();
  });

  it('мост промолчал — тоже null: лучше скрыть, чем предложить неработающее', async () => {
    expect(await loadPort(new Error('мост не ответил'))).toBeNull();
  });
});
