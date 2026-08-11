/**
 * SEC-024 (блокер приёмки №5). Регрессия на сквозном сценарии:
 * 5 неверных попыток → перезапуск приложения → задержка ещё действует.
 *
 * До правки `failedAttempts` и `lockedUntil` жили только в `AppState`, а
 * `initialState` обнулял их при каждом запуске. Вор устройства (THREAT-MODEL
 * §2.3) снимал приложение из списка задач после четвёртой попытки и получал
 * ещё четыре без задержки — обещание BEHAVIOR §5.2 не выполнялось никогда.
 *
 * «Перезапуск» здесь настоящий: новый `AppController` над теми же файлами и
 * теми же настройками. Настройки переживают перезапуск (это файл вне
 * vault'а), состояние в памяти — нет.
 */
import { describe, expect, it } from 'vitest';
import type { AppHost } from '../src/contract.js';
import { AppController } from '../src/state/store.js';
import { createTestHost, memoryPreferences } from './host.js';

/** Ключ настроек со счётчиком попыток — тот же, что в `store.ts`. */
const GUARD_KEY = 'security.unlockGuard';

/**
 * Запас по времени. Тест намеренно идёт через настоящий Argon2id с боевыми
 * параметрами (t=3, m=64 МиБ): именно его стоимость — первый слой защиты, и
 * подменять его облегчённым значило бы проверять не то, что работает у
 * пользователя. Десяток выводов ключа на тест не укладывается в умолчание
 * vitest в 5 с, когда рядом идут тесты соседних пакетов.
 */
const SLOW = 60_000;

const PASSWORD = 'верный пароль';
const FILES = { 'Секрет.md': '# Секрет\n\nЛичная запись, не для чужих глаз.\n' };

async function start(host: AppHost): Promise<AppController> {
  const app = new AppController(host);
  await app.boot();
  return app;
}

/**
 * Перезапуск: тот же диск и те же настройки, новое состояние в памяти.
 * Настройки пересоздаются из сохранённых значений — ровно так их читает
 * оболочка после холодного старта.
 */
function restart(host: AppHost, stored: Record<string, unknown>): AppHost {
  return { ...host, prefs: memoryPreferences(stored) };
}

describe('SEC-024: задержка после неверных попыток переживает перезапуск', () => {
  it('5 неверных попыток → перезапуск → задержка ещё действует', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const app = await start(host);
    await app.setVaultPassword(PASSWORD);
    const encrypted = await app.encryptNote('Секрет.md');
    expect(encrypted).toBe('Секрет.md.enc');
    app.lockAll();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await app.unlock(encrypted!, 'не тот пароль'), `попытка ${attempt}`).toBeNull();
    }
    expect(app.getState().failedAttempts).toBe(5);
    expect(app.unlockDelayLeftMs).toBeGreaterThan(0);
    const before = app.unlockDelayLeftMs;
    app.dispose();

    /* Перезапуск. */
    const stored = await host.prefs.get<unknown>(GUARD_KEY, null);
    expect(stored, 'счётчик обязан лежать в настройках, а не только в памяти').not.toBeNull();
    const restarted = await start(restart(host, { onboarded: true, [GUARD_KEY]: stored }));

    expect(restarted.getState().failedAttempts).toBe(5);
    expect(restarted.unlockDelayLeftMs).toBeGreaterThan(0);
    /* Задержка продолжается, а не начинается заново. */
    expect(restarted.unlockDelayLeftMs).toBeLessThanOrEqual(before);

    /* Пока идёт задержка, не принимается и верный пароль. */
    expect(await restarted.unlock('Секрет.md.enc', PASSWORD)).toBeNull();
    restarted.dispose();
  }, SLOW);

  it('перезапуск не дарит новых попыток без задержки', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const app = await start(host);
    await app.setVaultPassword(PASSWORD);
    const encrypted = (await app.encryptNote('Секрет.md'))!;
    app.lockAll();
    for (let attempt = 0; attempt < 4; attempt += 1) await app.unlock(encrypted, 'не тот пароль');
    expect(app.unlockDelayLeftMs).toBe(0);
    app.dispose();

    const stored = await host.prefs.get<unknown>(GUARD_KEY, null);
    const restarted = await start(restart(host, { onboarded: true, [GUARD_KEY]: stored }));
    /* Пятая попытка — пятая и есть, счётчик не начался заново. */
    expect(await restarted.unlock(encrypted, 'не тот пароль')).toBeNull();
    expect(restarted.getState().failedAttempts).toBe(5);
    expect(restarted.unlockDelayLeftMs).toBeGreaterThan(0);
    restarted.dispose();
  }, SLOW);

  it('перевод часов назад не отменяет задержку', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const app = await start(host);
    await app.setVaultPassword(PASSWORD);
    const encrypted = (await app.encryptNote('Секрет.md'))!;
    app.lockAll();
    for (let attempt = 0; attempt < 5; attempt += 1) await app.unlock(encrypted, 'не тот пароль');
    app.dispose();

    /* Вор переводит часы устройства на сутки назад и запускает приложение. */
    const stored = (await host.prefs.get<Record<string, number>>(GUARD_KEY, {}))!;
    const shifted = {
      ...stored,
      lastFailureAt: (stored.lastFailureAt ?? 0) + 86_400_000,
      lockedUntil: (stored.lockedUntil ?? 0) + 86_400_000,
    };
    const restarted = await start(restart(host, { onboarded: true, [GUARD_KEY]: shifted }));
    expect(restarted.getState().failedAttempts).toBe(5);
    expect(restarted.unlockDelayLeftMs).toBeGreaterThan(0);
    expect(restarted.unlockDelayLeftMs).toBeLessThanOrEqual(30_000);
    restarted.dispose();
  }, SLOW);

  it('данные не удаляются ни при каком числе попыток (BEHAVIOR §5.2)', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const app = await start(host);
    await app.setVaultPassword(PASSWORD);
    const encrypted = (await app.encryptNote('Секрет.md'))!;
    app.lockAll();
    const notesBefore = app.getState().notes.length;

    for (let attempt = 0; attempt < 9; attempt += 1) await app.unlock(encrypted, 'не тот пароль');

    expect(app.getState().notes).toHaveLength(notesBefore);
    /* Контейнер на диске цел — байт в байт то, что записало шифрование. */
    const container = await host.storage.read(encrypted);
    expect(container).not.toBeNull();
    expect(container!.byteLength).toBeGreaterThan(0);
    app.dispose();
  }, SLOW);
});
