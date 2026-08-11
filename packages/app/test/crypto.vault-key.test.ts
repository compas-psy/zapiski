/**
 * Иерархия ключей на уровне приложения (ТЗ §3.3).
 *
 * Ядро уже проверено отдельно (`packages/core/test/crypto.test.ts`): контейнер,
 * HKDF, версии. Здесь проверяется то, ради чего иерархия и заводилась, — как
 * это выглядит для человека:
 *
 *   · пароль спрашивают ОДИН раз, а не на каждую заметку;
 *   · вторая заметка шифруется молча;
 *   · разблокировка одной открывает ключ хранилища, и следующая открывается
 *     без второго ввода;
 *   · автозамок закрывает и ключ, иначе «заперто» перестаёт что-либо значить;
 *   · «Шифровать новые заметки» действительно создаёт заметку зашифрованной,
 *     не положив открытый текст на диск даже на мгновение;
 *   · смена пароля перешифровывает всё и не пускает по старому.
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const PASSWORD = 'верный пароль';
const FILES = {
  'Первая.md': '# Первая\n\nтекст первой\n',
  'Вторая.md': '# Вторая\n\nтекст второй\n',
};

async function boot(files: Record<string, string> = FILES): Promise<AppController> {
  const app = new AppController(createTestHost({ files, prefs: { onboarded: true } }));
  await app.boot();
  return app;
}

describe('пароль хранилища — один на всё (ТЗ §3.3)', () => {
  it('задаётся один раз, вторая заметка шифруется без пароля', async () => {
    const app = await boot();
    expect(await app.hasVaultPassword()).toBe(false);

    await app.setVaultPassword(PASSWORD);
    expect(await app.hasVaultPassword()).toBe(true);

    const first = await app.encryptNote('Первая.md');
    const second = await app.encryptNote('Вторая.md');
    expect(first).toBe('Первая.md.enc');
    expect(second).toBe('Вторая.md.enc');
  });

  it('одна разблокировка открывает и вторую заметку — Argon2id один раз', async () => {
    const app = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');
    await app.encryptNote('Вторая.md');
    app.lockAll();
    expect(app.vaultUnlocked).toBe(false);

    expect(await app.unlock('Первая.md.enc', PASSWORD)).toContain('текст первой');
    expect(app.vaultUnlocked).toBe(true);

    /* Вторая — уже без пароля: ключ выводится из master по keyId. */
    expect(await app.openEncrypted('Вторая.md.enc')).toContain('текст второй');
  });

  it('неверный пароль ничего не открывает и не портит', async () => {
    const app = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');
    app.lockAll();

    expect(await app.unlock('Первая.md.enc', 'не тот')).toBeNull();
    expect(app.vaultUnlocked).toBe(false);
    expect(await app.unlock('Первая.md.enc', PASSWORD)).toContain('текст первой');
  });

  it('автозамок закрывает и ключ хранилища', async () => {
    const app = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');
    expect(app.vaultUnlocked).toBe(true);

    app.lockAll();
    expect(app.vaultUnlocked).toBe(false);
    /* Без ключа заметка не открывается молча — нужен пароль. */
    expect(await app.openEncrypted('Первая.md.enc')).toBeNull();
  });
});

describe('шифрование не спотыкается о переименование', () => {
  /**
   * Найдено живым прогоном, а не тестом: заметка переименовывает себя по
   * заголовку через две секунды после набора (BEHAVIOR §2.2), а меню держит
   * путь, взятый ДО переименования. Шифрование по такому пути бросало
   * «Нет такой заметки» прямо в интерфейс — то есть человек, напечатавший
   * заголовок и сразу полезший шифровать, получал ошибку на ровном месте.
   */
  it('шифрует заметку по её нынешнему пути, а не по устаревшему', async () => {
    const app = await boot({ 'Без названия.md': '# Без названия\n\nтекст\n' });
    await app.setVaultPassword(PASSWORD);

    /* Переименование по заголовку — та же операция, что делает таймер. */
    await app.save('Без названия.md', '# Личное\n\nтекст\n');
    await app.flushRenamesNow(true);
    expect(app.getState().notes.some((note) => note.path === 'Личное.md')).toBe(true);

    /* Меню отдаёт старый путь — шифрование обязано дойти до новой заметки. */
    const target = await app.encryptNote('Без названия.md');
    expect(target).toBe('Личное.md.enc');
  });

  it('несуществующая заметка даёт null, а не исключение в интерфейс', async () => {
    const app = await boot();
    await app.setVaultPassword(PASSWORD);
    await expect(app.encryptNote('Такой.md')).resolves.toBeNull();
  });
});

describe('«Шифровать новые заметки»', () => {
  it('создаёт заметку сразу зашифрованной, без .md на диске', async () => {
    const app = await boot({});
    await app.setVaultPassword(PASSWORD);
    await app.setEncryptNewNotes(true);

    const path = await app.createNote(undefined, 'Тайная');
    expect(path).toBe('Тайная.md.enc');

    const state = app.getState();
    const note = state.notes.find((item) => item.path === 'Тайная.md.enc');
    expect(note?.encrypted).toBe(true);
    /* Ни одного открытого файла: `createEncryptedNote` пишет сразу .md.enc. */
    expect(state.notes.some((item) => item.path === 'Тайная.md')).toBe(false);
  });

  it('при запертом хранилище создаёт обычную заметку, а не обещает лишнего', async () => {
    const app = await boot({});
    await app.setVaultPassword(PASSWORD);
    await app.setEncryptNewNotes(true);
    app.lockAll();

    const path = await app.createNote(undefined, 'Обычная');
    expect(path).toBe('Обычная.md');
  });
});

describe('смена пароля (единственное место, ТЗ §3.3)', () => {
  it('перешифровывает заметки: новый пароль открывает, старый — нет', async () => {
    const app = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');
    await app.encryptNote('Вторая.md');

    const result = await app.changeVaultPassword(PASSWORD, 'новый длинный пароль');
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(2);
    expect(result.failed).toEqual([]);

    app.lockAll();
    expect(await app.unlock('Первая.md.enc', PASSWORD)).toBeNull();
    expect(await app.unlock('Первая.md.enc', 'новый длинный пароль')).toContain('текст первой');
    expect(await app.openEncrypted('Вторая.md.enc')).toContain('текст второй');
  });

  it('неверный текущий пароль не трогает ни одного файла', async () => {
    const app = await boot();
    await app.setVaultPassword(PASSWORD);
    await app.encryptNote('Первая.md');

    const result = await app.changeVaultPassword('не тот', 'новый длинный пароль');
    expect(result.ok).toBe(false);
    expect(result.changed).toBe(0);

    app.lockAll();
    /* Старый пароль по-прежнему работает: половины смены не случилось. */
    expect(await app.unlock('Первая.md.enc', PASSWORD)).toContain('текст первой');
  });
});
