/**
 * Биометрия и проверяемость пароля хранилища.
 *
 * ── Почему этих проверок не было ────────────────────────────────────────────
 *
 * В тестовом хосте стоял `biometrics: null`. Это законный случай (платформа
 * без модуля обязана СКРЫВАТЬ тумблер), но он был единственным: путь
 * «включить отпечаток → открыть им заметку» не выполнялся ни разу ни одним
 * тестом. Через эту дыру прошли три дефекта сразу, и все три заказчик увидел
 * как «переключатель расшифровки Биометрии не срабатывает»:
 *
 *  1. включение принимало ЛЮБОЙ пароль, в том числе пустой: ключ выводился из
 *     набранного, `enroll` отрабатывал, тумблер вставал в «включено» — а палец
 *     потом не открывал ничего, потому что в модуле лежал ключ от другого
 *     пароля;
 *  2. тумблер в листе шифрования («Разблокировать отпечатком», включён по
 *     умолчанию) клал ключ в модуль, но не выставлял настройку
 *     `security.biometrics`. Замок спрашивает именно её — и палец не
 *     предлагался никогда;
 *  3. неподходящая привязка возвращала `null`, неотличимый от отмены: на
 *     экране не менялось ничего.
 *
 * Ниже — по проверке на каждый, плюс проверяемость пароля, без которой первый
 * дефект не чинится в принципе.
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { createTestHost, fakeBiometrics } from './host.js';

const PASSWORD = 'верный пароль';
const FILES = { 'Первая.md': '# Первая\n\nтекст первой\n' };

async function boot(): Promise<{
  app: AppController;
  bio: ReturnType<typeof fakeBiometrics>;
  host: ReturnType<typeof createTestHost>;
}> {
  const bio = fakeBiometrics();
  const host = createTestHost({
    files: FILES,
    prefs: { onboarded: true },
    platform: { biometrics: bio.provider },
  });
  const app = new AppController(host);
  await app.boot();
  return { app, bio, host };
}

describe('пароль хранилища проверяем, а не принимается на слово', () => {
  it('верный — «ok», неверный — «wrong», и это разные ответы', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');

    expect(await app.verifyVaultPassword(PASSWORD)).toBe('ok');
    expect(await app.verifyVaultPassword('не тот')).toBe('wrong');
  });

  it('проверяется без единой зашифрованной заметки — по контрольной записи', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD);
    /* Ни одной зашифрованной заметки нет — раньше проверять было НЕЧЕМ. */
    expect(app.getState().notes.some((note) => note.encrypted)).toBe(false);

    expect(await app.verifyVaultPassword(PASSWORD)).toBe('ok');
    expect(await app.verifyVaultPassword('не тот')).toBe('wrong');
  });

  it('пустая строка не считается верным паролем', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD);
    expect(await app.verifyVaultPassword('')).toBe('wrong');
  });
});

describe('биометрия включается только по верному паролю', () => {
  it('пустой пароль — отказ, ключ в модуль не уезжает', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD);

    expect(await app.setBiometricsEnabled(true, '')).toBe('wrong');
    expect(bio.stored()).toBeNull();
    expect(await app.biometricsEnabled()).toBe(false);
  });

  it('неверный пароль — отказ, а не «включено»', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');

    expect(await app.setBiometricsEnabled(true, 'не тот')).toBe('wrong');
    expect(bio.stored()).toBeNull();
    expect(await app.biometricsEnabled()).toBe(false);
  });

  it('верный пароль — включено, ключ в модуле, настройка записана', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD);

    expect(await app.setBiometricsEnabled(true, PASSWORD)).toBe('on');
    expect(bio.stored()).not.toBeNull();
    expect(await app.biometricsEnabled()).toBe(true);
  });

  it('выключение снимает привязку и настройку', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.setBiometricsEnabled(true, PASSWORD);

    expect(await app.setBiometricsEnabled(false)).toBe('off');
    expect(bio.stored()).toBeNull();
    expect(await app.biometricsEnabled()).toBe(false);
  });
});

describe('тумблер в листе шифрования доводит дело до конца', () => {
  it('включённый при установке пароля — биометрия действительно включена', async () => {
    const { app, bio } = await boot();
    /* Ровно то, что делает `EncryptSheet`: пароль + тумблер «отпечатком». */
    await app.setVaultPassword(PASSWORD, true);

    expect(bio.stored()).not.toBeNull();
    /* Замок спрашивает именно настройку — без неё палец не предложат ни разу. */
    expect(await app.biometricsEnabled()).toBe(true);
  });

  it('выключённый — ни ключа, ни настройки', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD, false);

    expect(bio.stored()).toBeNull();
    expect(await app.biometricsEnabled()).toBe(false);
  });
});

describe('разблокировка отпечатком', () => {
  it('включённая биометрия открывает заметку без пароля', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD, true);
    const path = await app.encryptNote('Первая.md');
    app.lockAll();

    const outcome = await app.unlockWithBiometrics(path as string);
    expect(outcome.kind).toBe('unlocked');
    expect(outcome.kind === 'unlocked' && outcome.body).toContain('текст первой');
  });

  it('отмена — не ошибка: привязка остаётся, экран молчит', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD, true);
    const path = await app.encryptNote('Первая.md');
    app.lockAll();
    bio.cancel(true);

    expect((await app.unlockWithBiometrics(path as string)).kind).toBe('cancelled');
    expect(bio.stored()).not.toBeNull();
    expect(await app.biometricsEnabled()).toBe(true);
  });

  it('устаревшая привязка — «stale», она снимается и об этом можно сказать', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD, true);
    const path = await app.encryptNote('Первая.md');
    /* В модуль кладётся ключ от другого хранилища. На устройстве так выглядит
       смена пароля на втором компьютере: палец сработает, а ключ не подойдёт. */
    await bio.provider.enroll('vault', new Uint8Array(32));
    app.lockAll();

    const outcome = await app.unlockWithBiometrics(path as string);
    expect(outcome.kind).toBe('stale');
    /* Не подошла — значит снята: иначе палец «не работает» вечно и молча. */
    expect(bio.stored()).toBeNull();
    expect(await app.biometricsEnabled()).toBe(false);
  });
});

describe('смена пароля и биометрия', () => {
  it('без единой зашифрованной заметки старый пароль всё равно проверяется', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD);

    const wrong = await app.changeVaultPassword('не тот', 'новый длинный пароль');
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toBe('wrong');

    const right = await app.changeVaultPassword(PASSWORD, 'новый длинный пароль');
    expect(right.ok).toBe(true);
  });

  it('перевыпускает привязку, если биометрия была включена', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD, true);
    await app.encryptNote('Первая.md');
    const before = bio.stored();

    expect((await app.changeVaultPassword(PASSWORD, 'новый длинный пароль')).ok).toBe(true);
    expect(bio.stored()).not.toBeNull();
    expect(bio.stored()).not.toEqual(before);
    expect(await app.biometricsEnabled()).toBe(true);
  });

  it('не заводит биометрию тому, кто её не включал', async () => {
    const { app, bio } = await boot();
    await app.setVaultPassword(PASSWORD, false);
    await app.encryptNote('Первая.md');

    expect((await app.changeVaultPassword(PASSWORD, 'новый длинный пароль')).ok).toBe(true);
    expect(bio.stored()).toBeNull();
    expect(await app.biometricsEnabled()).toBe(false);
  });

  it('после смены заметка открывается новым паролем и не открывается старым', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD);
    const path = (await app.encryptNote('Первая.md')) as string;
    await app.changeVaultPassword(PASSWORD, 'новый длинный пароль');
    app.lockAll();

    expect(await app.unlock(path, PASSWORD)).toBeNull();
    expect(await app.unlock(path, 'новый длинный пароль')).toContain('текст первой');
  });
});

describe('открытый текст никогда не попадает в зашифрованный файл', () => {
  /**
   * Самый опасный дефект этой задачи, и найден он не тестом, а браузером.
   *
   * `save()` разбирал два случая: есть запись в `unlocked` — шифруем, нет —
   * пишем как есть. Второй случай наступает штатно: выход из заметки запирает
   * её (BEHAVIOR §5.3) и чистит `unlocked`, а редактор при возврате ещё
   * держит текст и через полсекунды сохраняет его. Открытый markdown уходил
   * прямо в `.md.enc`: контейнер затирался, заметка переставала открываться
   * паролем, а на диске и в облаке оставался читаемый текст.
   *
   * Воспроизведение здесь — тот же жест: разблокировать, запереть, сохранить.
   */
  it('запертая заметка не переписывается открытым текстом', async () => {
    const { app } = await boot();
    await app.setVaultPassword(PASSWORD);
    const path = (await app.encryptNote('Первая.md')) as string;

    /* Выход из заметки: ключ заметки из памяти ушёл, master остался. */
    app.lockNote(path);
    await app.save(path, '# Первая\n\nсовсем другой текст\n');

    /* Файл обязан остаться контейнером и открываться прежним паролем. */
    app.lockAll();
    const body = await app.unlock(path, PASSWORD);
    expect(body).not.toBeNull();
    expect(body).toContain('совсем другой текст');
  });

  it('при запертом хранилище запись не делается вовсе, файл цел', async () => {
    const { app, host } = await boot();
    await app.setVaultPassword(PASSWORD);
    const path = (await app.encryptNote('Первая.md')) as string;
    const before = await host.storage.read(path);

    /* Хранилище заперто целиком — ключ вывести не из чего. */
    app.lockAll();
    await app.save(path, '# Первая\n\nтекст мимо ключа\n');

    const after = await host.storage.read(path);
    expect(after).toEqual(before);
    expect(await app.unlock(path, PASSWORD)).toContain('текст первой');
  });
});
