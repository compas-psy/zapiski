/**
 * Крипто (ТЗ §3.3, BEHAVIOR §5): round-trip, неверный пароль → null,
 * повреждённый контейнер, отсутствие открытого текста на диске.
 *
 * Argon2id гоняется с облегчёнными параметрами: проверяем контракт и формат,
 * а не стойкость KDF (её задают ARGON2_PARAMS по RFC 9106).
 */
import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { WebCryptoProvider, ARGON2_PARAMS, unlockDelayMs } from '../src/crypto/provider.js';
import { decodeContainer, encodeContainer, looksEncrypted, MAGIC } from '../src/crypto/container.js';
import { decryptNoteFile, decryptNoteToDisk, encryptedPathOf, encryptNoteFile, passwordHint, plainPathOf } from '../src/crypto/notes.js';
import { catalog } from '../src/i18n/i18n.js';

/** Быстрые параметры KDF для тестов; продакшен-значения — в ARGON2_PARAMS. */
const provider = new WebCryptoProvider({ argon2: { memorySize: 1024, iterations: 1, parallelism: 1 } });

const PLAIN = '# Дневник\n\nОчень личный текст: планы на осень и одна честная мысль о себе.\n';

describe('параметры KDF', () => {
  it('по умолчанию — второй рекомендованный набор RFC 9106', () => {
    expect(ARGON2_PARAMS).toEqual({ iterations: 3, memorySize: 65_536, parallelism: 4, hashLength: 32 });
  });

  it('задержки после неудачных попыток по BEHAVIOR §5.2', () => {
    expect(unlockDelayMs(1)).toBe(0);
    expect(unlockDelayMs(4)).toBe(0);
    expect(unlockDelayMs(5)).toBe(30_000);
    expect(unlockDelayMs(8)).toBe(300_000);
  });
});

describe('контейнер ZPSK', () => {
  it('кодируется и декодируется без потерь', () => {
    const container = {
      magic: MAGIC,
      version: 1,
      salt: new Uint8Array(16).fill(7),
      nonce: new Uint8Array(12).fill(9),
      ciphertext: new Uint8Array(32).fill(3),
      hint: 'первая буква — К',
    };
    const encoded = encodeContainer(container);
    expect(looksEncrypted(encoded)).toBe(true);
    const decoded = decodeContainer(encoded);
    expect(decoded?.hint).toBe('первая буква — К');
    expect(decoded?.salt).toEqual(container.salt);
    expect(decoded?.nonce).toEqual(container.nonce);
    expect(decoded?.ciphertext).toEqual(container.ciphertext);
  });

  it('мусор и обрезанный файл дают null, а не исключение', () => {
    expect(decodeContainer(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeContainer(new TextEncoder().encode('# обычная заметка'))).toBeNull();
    const valid = encodeContainer({
      magic: MAGIC,
      version: 1,
      salt: new Uint8Array(16),
      nonce: new Uint8Array(12),
      ciphertext: new Uint8Array(32),
    });
    expect(decodeContainer(valid.slice(0, 20))).toBeNull();
  });
});

describe('шифрование round-trip', () => {
  it('расшифровывает то, что зашифровало', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('очень длинный пароль', salt);
    const container = await provider.encrypt(PLAIN, key, 'подсказка');
    expect(await provider.decrypt(container, key)).toBe(PLAIN);
  });

  it('ключ неэкспортируемый (ADR-0001, «крипто в managed-памяти»)', async () => {
    const key = await provider.deriveMasterKey('пароль12', provider.randomSalt());
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('заголовок читается без ключа: версия, соль, подсказка', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль12', salt);
    const container = await provider.encrypt(PLAIN, key, 'девичья фамилия');
    const header = provider.parseHeader(container);
    expect(header).not.toBeNull();
    expect(header?.version).toBe(1);
    expect(header?.salt).toEqual(salt);
    expect(header?.hint).toBe('девичья фамилия');
  });

  it('неверный пароль возвращает null, а не бросает (BEHAVIOR §5.2)', async () => {
    const salt = provider.randomSalt();
    const right = await provider.deriveMasterKey('правильный пароль', salt);
    const wrong = await provider.deriveMasterKey('неправильный пароль', salt);
    const container = await provider.encrypt(PLAIN, right);
    await expect(provider.decrypt(container, wrong)).resolves.toBeNull();
    expect(catalog('ru').errors.wrongPassword).toBe('Пароль не подошёл');
  });

  it('повреждённый контейнер обрабатывается корректно', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль12', salt);
    const container = await provider.encrypt(PLAIN, key);
    const damaged = new Uint8Array(container);
    damaged[damaged.length - 5] = ((damaged[damaged.length - 5] ?? 0) ^ 0xff) & 0xff;
    await expect(provider.decrypt(damaged, key)).resolves.toBeNull();
    await expect(provider.decrypt(new Uint8Array([0, 1, 2]), key)).resolves.toBeNull();
  });

  it('одинаковый текст даёт разные контейнеры (случайный nonce)', async () => {
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль12', salt);
    const a = await provider.encrypt(PLAIN, key);
    const b = await provider.encrypt(PLAIN, key);
    expect(a).not.toEqual(b);
    expect(await provider.decrypt(b, key)).toBe(PLAIN);
  });

  it('per-note ключи различаются (иерархия ключей ТЗ §3.3)', async () => {
    const salt = provider.randomSalt();
    const first = await provider.deriveNoteKey('пароль12', salt, 'note-1');
    const second = await provider.deriveNoteKey('пароль12', salt, 'note-2');
    const container = await provider.encrypt(PLAIN, first);
    expect(await provider.decrypt(container, second)).toBeNull();
    expect(await provider.decrypt(container, first)).toBe(PLAIN);
  });
});

describe('заметка на диске (ТЗ §3.3)', () => {
  it('после шифрования открытого текста на диске нет', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Дневник.md': PLAIN } });
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль12', salt);

    const target = await encryptNoteFile(storage, provider, 'Дневник.md', key, 'подсказка');
    expect(target).toBe('Дневник.md.enc');
    expect(storage.paths()).not.toContain('Дневник.md');
    expect(storage.containsPlaintext('Очень личный текст')).toBe(false);
    expect(storage.containsPlaintext('супервизию')).toBe(false);

    // Подсказка лежит открытым текстом — так задумано (contract.ts).
    expect(await passwordHint(storage, provider, target)).toBe('подсказка');
    expect(await decryptNoteFile(storage, provider, target, key)).toBe(PLAIN);
  });

  it('снятие шифрования возвращает .md, а неверный ключ ничего не меняет', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Дневник.md': PLAIN } });
    const salt = provider.randomSalt();
    const key = await provider.deriveMasterKey('пароль12', salt);
    const wrong = await provider.deriveMasterKey('другой пароль', salt);
    const encrypted = await encryptNoteFile(storage, provider, 'Дневник.md', key);

    expect(await decryptNoteToDisk(storage, provider, encrypted, wrong)).toBeNull();
    expect(storage.paths()).toContain('Дневник.md.enc');

    expect(await decryptNoteToDisk(storage, provider, encrypted, key)).toBe('Дневник.md');
    expect(storage.snapshot()['Дневник.md']).toBe(PLAIN);
    expect(storage.paths()).not.toContain('Дневник.md.enc');
  });

  it('пути .md ↔ .md.enc переводятся друг в друга', () => {
    expect(encryptedPathOf('Проекты/Идея.md')).toBe('Проекты/Идея.md.enc');
    expect(encryptedPathOf('Проекты/Идея.md.enc')).toBe('Проекты/Идея.md.enc');
    expect(plainPathOf('Проекты/Идея.md.enc')).toBe('Проекты/Идея.md');
    expect(plainPathOf('Проекты/Идея.md')).toBe('Проекты/Идея.md');
  });

  it('чужой ключ для encrypt отвергается: без соли контейнер не откроется', async () => {
    const foreign = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    await expect(provider.encrypt(PLAIN, foreign as CryptoKey)).rejects.toThrow();
  });
});
