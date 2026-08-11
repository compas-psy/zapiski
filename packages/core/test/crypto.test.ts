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
import {
  CONTAINER_VERSION,
  decodeContainer,
  encodeContainer,
  LEGACY_CONTAINER_VERSION,
  looksEncrypted,
  MAGIC,
} from '../src/crypto/container.js';
import {
  createEncryptedNote,
  decryptNoteFile,
  decryptNoteToDisk,
  encryptedPathOf,
  encryptNoteFile,
  passwordHint,
  plainPathOf,
  rewriteToCurrentVersion,
} from '../src/crypto/notes.js';
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

/** Ключ заметки из пароля: два шага, как в приложении. */
async function noteKey(password: string, salt: Uint8Array, keyId = provider.randomKeyId()) {
  const master = await provider.deriveMaster(password, salt);
  return { master, key: await provider.deriveNoteKey(master, keyId), keyId };
}

describe('шифрование round-trip', () => {
  it('расшифровывает то, что зашифровало', async () => {
    const salt = provider.randomSalt();
    const { key } = await noteKey('очень длинный пароль', salt);
    const container = await provider.encrypt(PLAIN, key, 'подсказка');
    expect(await provider.decrypt(container, key)).toBe(PLAIN);
  });

  it('ключ неэкспортируемый (ADR-0001, «крипто в managed-памяти»)', async () => {
    const { key, master } = await noteKey('пароль12', provider.randomSalt());
    expect(key.extractable).toBe(false);
    expect(key.algorithm.name).toBe('AES-GCM');
    /* Сам master тоже: из него нельзя вынуть байты и унести. */
    expect(master.key.extractable).toBe(false);
  });

  it('заголовок читается без ключа: версия, соль, подсказка, keyId', async () => {
    const salt = provider.randomSalt();
    const { key, keyId } = await noteKey('пароль12', salt);
    const container = await provider.encrypt(PLAIN, key, 'девичья фамилия');
    const header = provider.parseHeader(container);
    expect(header).not.toBeNull();
    expect(header?.version).toBe(CONTAINER_VERSION);
    expect(header?.salt).toEqual(salt);
    expect(header?.keyId).toEqual(keyId);
    expect(header?.hint).toBe('девичья фамилия');
  });

  it('неверный пароль возвращает null, а не бросает (BEHAVIOR §5.2)', async () => {
    const salt = provider.randomSalt();
    const keyId = provider.randomKeyId();
    const { key: right } = await noteKey('правильный пароль', salt, keyId);
    const { key: wrong } = await noteKey('неправильный пароль', salt, keyId);
    const container = await provider.encrypt(PLAIN, right);
    await expect(provider.decrypt(container, wrong)).resolves.toBeNull();
    expect(catalog('ru').errors.wrongPassword).toBe('Пароль не подошёл');
  });

  it('повреждённый контейнер обрабатывается корректно', async () => {
    const { key } = await noteKey('пароль12', provider.randomSalt());
    const container = await provider.encrypt(PLAIN, key);
    const damaged = new Uint8Array(container);
    damaged[damaged.length - 5] = ((damaged[damaged.length - 5] ?? 0) ^ 0xff) & 0xff;
    await expect(provider.decrypt(damaged, key)).resolves.toBeNull();
    await expect(provider.decrypt(new Uint8Array([0, 1, 2]), key)).resolves.toBeNull();
  });

  it('одинаковый текст даёт разные контейнеры (случайный nonce)', async () => {
    const { key } = await noteKey('пароль12', provider.randomSalt());
    const a = await provider.encrypt(PLAIN, key);
    const b = await provider.encrypt(PLAIN, key);
    expect(a).not.toEqual(b);
    expect(await provider.decrypt(b, key)).toBe(PLAIN);
  });

  it('ключи двух заметок различаются при ОДНОМ пароле (иерархия ТЗ §3.3)', async () => {
    const salt = provider.randomSalt();
    const master = await provider.deriveMaster('пароль12', salt);
    const first = await provider.deriveNoteKey(master, provider.randomKeyId());
    const second = await provider.deriveNoteKey(master, provider.randomKeyId());
    const container = await provider.encrypt(PLAIN, first);
    expect(await provider.decrypt(container, second)).toBeNull();
    expect(await provider.decrypt(container, first)).toBe(PLAIN);
  });

  it('тот же keyId и тот же пароль дают тот же ключ — иначе заметка не откроется', async () => {
    const salt = provider.randomSalt();
    const keyId = provider.randomKeyId();
    const { key: written } = await noteKey('пароль12', salt, keyId);
    const container = await provider.encrypt(PLAIN, written);
    /* Второй сеанс: пароль тот же, объекты новые. */
    const { key: reopened } = await noteKey('пароль12', salt, keyId);
    expect(await provider.decrypt(container, reopened)).toBe(PLAIN);
  });

  it('биометрия открывает master без Argon2id: материал → тот же ключ', async () => {
    const salt = provider.randomSalt();
    const keyId = provider.randomKeyId();
    const material = await provider.deriveMasterMaterial('пароль12', salt);
    /* Ровно это уходит в Android Keystore / Hello / WebAuthn PRF. */
    const fromKeystore = await provider.importMaster(material.slice(), salt);
    const container = await provider.encrypt(PLAIN, await provider.deriveNoteKey(fromKeystore, keyId));

    const fromPassword = await provider.deriveMaster('пароль12', salt);
    expect(await provider.decrypt(container, await provider.deriveNoteKey(fromPassword, keyId))).toBe(PLAIN);
  });

  it('ключом версии 1 писать нельзя — иначе иерархия обходится молча', async () => {
    const legacy = await provider.deriveLegacyKey('пароль12', provider.randomSalt());
    await expect(provider.encrypt(PLAIN, legacy)).rejects.toThrow();
  });
});

describe('заметка на диске (ТЗ §3.3)', () => {
  it('после шифрования открытого текста на диске нет', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Дневник.md': PLAIN } });
    const master = await provider.deriveMaster('пароль12', provider.randomSalt());

    const target = await encryptNoteFile(storage, provider, 'Дневник.md', master, 'подсказка');
    expect(target).toBe('Дневник.md.enc');
    expect(storage.paths()).not.toContain('Дневник.md');
    expect(storage.containsPlaintext('Очень личный текст')).toBe(false);
    expect(storage.containsPlaintext('честная мысль')).toBe(false);

    // Подсказка лежит открытым текстом — так задумано (contract.ts).
    expect(await passwordHint(storage, provider, target)).toBe('подсказка');
    expect(await decryptNoteFile(storage, provider, target, master)).toBe(PLAIN);
  });

  it('одним ключом хранилища открываются РАЗНЫЕ заметки — пароль один', async () => {
    const storage = new MemoryVaultStorage({
      files: { 'Первая.md': PLAIN, 'Вторая.md': '# Вторая\n\nтоже личное\n' },
    });
    const master = await provider.deriveMaster('пароль12', provider.randomSalt());
    const first = await encryptNoteFile(storage, provider, 'Первая.md', master);
    const second = await encryptNoteFile(storage, provider, 'Вторая.md', master);

    expect(await decryptNoteFile(storage, provider, first, master)).toBe(PLAIN);
    expect(await decryptNoteFile(storage, provider, second, master)).toContain('тоже личное');
    /* И у них разные keyId: одинаковый означал бы один ключ на весь vault. */
    const idOf = async (path: string) =>
      provider.parseHeader((await storage.read(path))!)?.keyId?.join(',');
    expect(await idOf(first)).not.toBe(await idOf(second));
  });

  it('новая заметка создаётся зашифрованной, минуя .md на диске', async () => {
    const storage = new MemoryVaultStorage();
    const master = await provider.deriveMaster('пароль12', provider.randomSalt());
    const target = await createEncryptedNote(storage, provider, 'Тайная.md', master, '# Тайная\n\nтекст\n');

    expect(target).toBe('Тайная.md.enc');
    /* Ни одного файла с открытым текстом — даже на мгновение его не было. */
    expect(storage.paths()).toEqual(['Тайная.md.enc']);
    expect(storage.containsPlaintext('текст')).toBe(false);
    expect(await decryptNoteFile(storage, provider, target, master)).toContain('# Тайная');
  });

  it('снятие шифрования возвращает .md, а неверный пароль ничего не меняет', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Дневник.md': PLAIN } });
    const salt = provider.randomSalt();
    const master = await provider.deriveMaster('пароль12', salt);
    const wrong = await provider.deriveMaster('другой пароль', salt);
    const encrypted = await encryptNoteFile(storage, provider, 'Дневник.md', master);

    expect(await decryptNoteToDisk(storage, provider, encrypted, wrong)).toBeNull();
    expect(storage.paths()).toContain('Дневник.md.enc');

    expect(await decryptNoteToDisk(storage, provider, encrypted, master)).toBe('Дневник.md');
    expect(storage.snapshot()['Дневник.md']).toBe(PLAIN);
    expect(storage.paths()).not.toContain('Дневник.md.enc');
  });

  /**
   * Контейнеры версии 1 создавались до иерархии: ключ выводился прямо из
   * пароля, у каждой заметки свой. Они обязаны открываться и после перехода —
   * иначе «обновление приложения съело мои заметки».
   */
  describe('контейнер версии 1 (до иерархии ключей)', () => {
    /** Как писала прежняя версия: Argon2id → AES-ключ, без keyId. */
    async function writeLegacy(storage: MemoryVaultStorage, path: string, password: string, hint?: string) {
      const salt = provider.randomSalt();
      const key = await provider.deriveLegacyKey(password, salt);
      const nonce = new Uint8Array(12).fill(4);
      const ciphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce as BufferSource },
          key,
          new TextEncoder().encode(PLAIN) as BufferSource,
        ),
      );
      const container: Parameters<typeof encodeContainer>[0] = {
        magic: MAGIC,
        version: LEGACY_CONTAINER_VERSION,
        salt,
        nonce,
        ciphertext,
      };
      if (hint !== undefined) container.hint = hint;
      await storage.write(path, encodeContainer(container));
      return salt;
    }

    it('читается своим паролем', async () => {
      const storage = new MemoryVaultStorage();
      await writeLegacy(storage, 'Старая.md.enc', 'старый пароль');
      const master = await provider.deriveMaster('старый пароль', provider.randomSalt());
      /* master здесь ни при чём — версия 1 открывается паролем. */
      expect(await decryptNoteFile(storage, provider, 'Старая.md.enc', master, 'старый пароль')).toBe(PLAIN);
      expect(await decryptNoteFile(storage, provider, 'Старая.md.enc', master, 'не тот')).toBeNull();
    });

    it('переписывается в версию 2 и после этого открывается ключом хранилища', async () => {
      const storage = new MemoryVaultStorage();
      await writeLegacy(storage, 'Старая.md.enc', 'старый пароль', 'подсказка');
      const master = await provider.deriveMaster('старый пароль', provider.randomSalt());

      expect(await rewriteToCurrentVersion(storage, provider, 'Старая.md.enc', master, PLAIN)).toBe(true);
      const header = provider.parseHeader((await storage.read('Старая.md.enc'))!);
      expect(header?.version).toBe(CONTAINER_VERSION);
      expect(header?.hint).toBe('подсказка');
      /* Пароль больше не нужен: заметка живёт под ключом хранилища. */
      expect(await decryptNoteFile(storage, provider, 'Старая.md.enc', master)).toBe(PLAIN);
      /* Повторный вызов ничего не делает: переписывать нечего. */
      expect(await rewriteToCurrentVersion(storage, provider, 'Старая.md.enc', master, PLAIN)).toBe(false);
    });
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
