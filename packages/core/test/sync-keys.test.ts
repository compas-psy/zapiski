/**
 * SEC-001 §2, §6.0 — доменные подключи синхронизации, генерация/обёртка SMK,
 * код восстановления. Чистая криптография: без сети, без UI, без сервера.
 *
 * Recovery secret — 256 бит CSPRNG (не 128, как минимум в дизайн-документе):
 * заказчик явно потребовал «не менее 256 бит» для реализации. Обёртка SMK
 * этим кодом — через HKDF, а не Argon2id: код НЕ человеческий пароль, у него
 * уже 256 бит энтропии, замедлять офлайн-подбор нечего защищать (offline
 * guessing бессмыслен против случайного 256-битного значения независимо от
 * скорости KDF) — Argon2id здесь была бы работой без цели, а не запасом
 * прочности.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from '../src/util/bytes.js';
import {
  deriveContentKey,
  deriveCrdtKey,
  deriveManifestKey,
  deriveVersionsKey,
  formatRecoveryCode,
  generateRecoveryCode,
  generateSmk,
  parseRecoveryCode,
  RECOVERY_CODE_ENTROPY_BYTES,
  unwrapSmk,
  wrapSmk,
} from '../src/crypto/sync-keys.js';

const subtle = globalThis.crypto.subtle;

/** Раунд-трип шифрования конкретным ключом — проверка, что ключ рабочий и именно тот. */
async function roundTrips(key: CryptoKey): Promise<boolean> {
  const nonce = randomBytes(12);
  const plaintext = new TextEncoder().encode('проверка');
  try {
    const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext);
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ciphertext);
    return new TextDecoder().decode(decrypted) === 'проверка';
  } catch {
    return false;
  }
}

/** Может ли `other` расшифровать то, что зашифровал `key`? */
async function crossDecrypts(key: CryptoKey, other: CryptoKey): Promise<boolean> {
  const nonce = randomBytes(12);
  const plaintext = new TextEncoder().encode('секрет');
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext);
  try {
    await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, other, ciphertext);
    return true;
  } catch {
    return false;
  }
}

describe('generateSmk', () => {
  it('256 бит, не все нули, разный на каждый вызов', () => {
    const a = generateSmk();
    const b = generateSmk();
    expect(a.length).toBe(32);
    expect(a.some((byte) => byte !== 0)).toBe(true);
    expect(a).not.toEqual(b);
  });
});

describe('доменные подключи (SEC-001 §2.2)', () => {
  const smk = generateSmk();
  const accountSalt = randomBytes(16);

  it('один и тот же (smk, noteId, домен) детерминированно даёт один и тот же ключ на двух независимых вызовах', async () => {
    const first = await deriveContentKey(smk, accountSalt, 'note-1');
    const second = await deriveContentKey(smk, accountSalt, 'note-1');
    expect(await crossDecrypts(first, second)).toBe(true);
  });

  it('разные note_id дают криптографически разные ключи — чужим не расшифровать', async () => {
    const noteA = await deriveContentKey(smk, accountSalt, 'note-a');
    const noteB = await deriveContentKey(smk, accountSalt, 'note-b');
    expect(await crossDecrypts(noteA, noteB)).toBe(false);
  });

  it('разные домены одной заметки дают разные ключи (content ≠ crdt ≠ versions)', async () => {
    const content = await deriveContentKey(smk, accountSalt, 'note-1');
    const crdt = await deriveCrdtKey(smk, accountSalt, 'note-1');
    const versions = await deriveVersionsKey(smk, accountSalt, 'note-1');
    expect(await crossDecrypts(content, crdt)).toBe(false);
    expect(await crossDecrypts(content, versions)).toBe(false);
    expect(await crossDecrypts(crdt, versions)).toBe(false);
  });

  it('manifest — один ключ на аккаунт, без note_id, тоже детерминирован', async () => {
    const first = await deriveManifestKey(smk, accountSalt);
    const second = await deriveManifestKey(smk, accountSalt);
    expect(await crossDecrypts(first, second)).toBe(true);
  });

  it('разный SMK при том же note_id/домене даёт разные ключи', async () => {
    const otherSmk = generateSmk();
    const mine = await deriveContentKey(smk, accountSalt, 'note-1');
    const theirs = await deriveContentKey(otherSmk, accountSalt, 'note-1');
    expect(await crossDecrypts(mine, theirs)).toBe(false);
  });

  it('все производные ключи рабочие AES-256-GCM ключи', async () => {
    expect(await roundTrips(await deriveContentKey(smk, accountSalt, 'x'))).toBe(true);
    expect(await roundTrips(await deriveCrdtKey(smk, accountSalt, 'x'))).toBe(true);
    expect(await roundTrips(await deriveVersionsKey(smk, accountSalt, 'x'))).toBe(true);
    expect(await roundTrips(await deriveManifestKey(smk, accountSalt))).toBe(true);
  });

  it('ключи неэкспортируемы — материал SMK не утекает через них', async () => {
    const key = await deriveContentKey(smk, accountSalt, 'note-1');
    expect(key.extractable).toBe(false);
    await expect(subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

describe('код восстановления (SEC-001 §6.0, требование заказчика — 256, не 128 бит)', () => {
  it('256 бит CSPRNG-энтропии — фактическая длина, не только заявленная', async () => {
    expect(RECOVERY_CODE_ENTROPY_BYTES).toBe(32);
    const code = await generateRecoveryCode();
    expect(code.secret.length).toBe(32);
  });

  it('генерация статистически похожа на случайную, не на выдуманную', async () => {
    // Регрессия против «забыли вызвать CSPRNG» (вернули нули/константу).
    const codes: Uint8Array[] = [];
    for (let i = 0; i < 200; i += 1) codes.push((await generateRecoveryCode()).secret);
    const allBytes = codes.flatMap((c) => Array.from(c));
    const distinctByteValues = new Set(allBytes).size;
    // 200×32 = 6400 байт случайного источника — почти наверняка встретит
    // почти все 256 возможных значений байта; выдуманная константа — единицы.
    expect(distinctByteValues).toBeGreaterThan(200);
    const asHex = codes.map((c) => Buffer.from(c).toString('hex'));
    expect(new Set(asHex).size).toBe(codes.length);
  });

  it('формат → разбор без потерь', async () => {
    const code = await generateRecoveryCode();
    const formatted = formatRecoveryCode(code);
    const parsed = await parseRecoveryCode(formatted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.secret).toEqual(code.secret);
  });

  it('контрольная сумма ловит опечатку локально, без обращения к серверу', async () => {
    const code = await generateRecoveryCode();
    const formatted = formatRecoveryCode(code);
    // Портим один символ в середине строки представления.
    const chars = formatted.split('');
    const target = chars.findIndex((c) => /[A-Z0-9]/.test(c) && c !== '-');
    chars[target] = chars[target] === 'A' ? 'B' : 'A';
    const tampered = chars.join('');

    const parsed = await parseRecoveryCode(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('checksum');
  });

  it('контрольная сумма ловит транспозицию соседних символов', async () => {
    const code = await generateRecoveryCode();
    const formatted = formatRecoveryCode(code);
    const chars = formatted.split('');
    const i = chars.findIndex((c, idx) => /[A-Z0-9]/.test(c) && /[A-Z0-9]/.test(chars[idx + 1] ?? '') && c !== chars[idx + 1]);
    if (i >= 0) {
      const tmp = chars[i];
      chars[i] = chars[i + 1] as string;
      chars[i + 1] = tmp as string;
      const parsed = await parseRecoveryCode(chars.join(''));
      expect(parsed.ok).toBe(false);
    }
  });

  it('мусорный ввод не бросает исключение', async () => {
    expect((await parseRecoveryCode('')).ok).toBe(false);
    expect((await parseRecoveryCode('не код вовсе')).ok).toBe(false);
    expect((await parseRecoveryCode('----------')).ok).toBe(false);
  });
});

describe('обёртка SMK кодом восстановления (SEC-001 §3, §6)', () => {
  it('раунд-трип: тот же код разворачивает тот же SMK', async () => {
    const smk = generateSmk();
    const code = await generateRecoveryCode();
    const wrapSalt = randomBytes(16);
    const wrapped = await wrapSmk(smk, code.secret, wrapSalt);
    const unwrapped = await unwrapSmk(wrapped, code.secret, wrapSalt);
    expect(unwrapped).toEqual(smk);
  });

  it('неверный код возвращает null, а не бросает (тот же принцип, что decrypt() заметки)', async () => {
    const smk = generateSmk();
    const wrapSalt = randomBytes(16);
    const wrapped = await wrapSmk(smk, (await generateRecoveryCode()).secret, wrapSalt);
    const wrongCode = (await generateRecoveryCode()).secret;
    await expect(unwrapSmk(wrapped, wrongCode, wrapSalt)).resolves.toBeNull();
  });

  it('обёрнутый блоб не содержит SMK как подстроку байт', async () => {
    const smk = generateSmk();
    const wrapSalt = randomBytes(16);
    const wrapped = await wrapSmk(smk, (await generateRecoveryCode()).secret, wrapSalt);
    const smkHex = Buffer.from(smk).toString('hex');
    const wrappedHex = Buffer.from(wrapped).toString('hex');
    expect(wrappedHex).not.toContain(smkHex);
  });

  it('подмена любого байта обёртки ломает разворачивание — тег GCM', async () => {
    const smk = generateSmk();
    const code = await generateRecoveryCode();
    const wrapSalt = randomBytes(16);
    const wrapped = await wrapSmk(smk, code.secret, wrapSalt);

    for (const index of [0, 5, wrapped.length - 1]) {
      const damaged = Uint8Array.from(wrapped);
      damaged[index] = (damaged[index]! ^ 0xff) & 0xff;
      await expect(unwrapSmk(damaged, code.secret, wrapSalt), `байт ${index}`).resolves.toBeNull();
    }
  });

  it('чужая соль не разворачивает обёртку', async () => {
    const smk = generateSmk();
    const code = await generateRecoveryCode();
    const wrapped = await wrapSmk(smk, code.secret, randomBytes(16));
    await expect(unwrapSmk(wrapped, code.secret, randomBytes(16))).resolves.toBeNull();
  });

  it('обрезанный и пустой блоб не роняют разворачивание', async () => {
    const code = await generateRecoveryCode();
    const salt = randomBytes(16);
    await expect(unwrapSmk(new Uint8Array(0), code.secret, salt)).resolves.toBeNull();
    await expect(unwrapSmk(new Uint8Array(5), code.secret, salt)).resolves.toBeNull();
  });
});
