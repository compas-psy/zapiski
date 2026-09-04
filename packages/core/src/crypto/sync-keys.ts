/**
 * SEC-001 фаза 1 — ключи синхронизации Облака Записок.
 *
 * Полный проект — `docs/dev/security/SEC-001-zero-knowledge-design.md`.
 * Здесь только чистая криптография: ни сети, ни хранилища, ни UI.
 *
 * ── Иерархия (design §2.2) ───────────────────────────────────────────────
 *
 *   crypto.getRandomValues(32)  →  SMK (sync master key, 256 бит)
 *                                   │  HKDF-SHA256, salt = соль аккаунта,
 *                                   │  info = доменная строка
 *          ┌──────────────┬─────────┼──────────────┬──────────────┐
 *      K_content       K_crdt    K_versions    K_manifest
 *      (по заметке)  (по заметке) (по заметке)  (на аккаунт)
 *
 * SMK НИКОГДА не используется для шифрования напрямую — только как корень
 * деривации. Доменное разделение делает две вещи разом: компрометация одного
 * контекста не раскрывает остальные, и у каждой пары (заметка, домен)
 * появляется СВОЙ бюджет нонсов, из-за чего случайный 96-битный нонс
 * (design §8.1, граница NIST SP 800-38D — 2^32 инвокаций на ключ) безопасен
 * без какого-либо состояния устройства.
 *
 * `K_wrap` из design §2.2 здесь СОЗНАТЕЛЬНО отсутствует: он нужен ровно для
 * ротации SMK, а ротация — фаза 2 (design §18). Заводить неиспользуемый
 * домен «на будущее» значило бы держать в коде ключ, который никто не
 * проверяет тестом.
 *
 * ── Восстановление: один механизм, 256 бит (требование заказчика) ────────
 *
 * Design §6.0 фиксировал 128 бит как МИНИМУМ и разрешал поднять. Заказчик
 * для реализации потребовал «не менее 256 бит CSPRNG-энтропии» — здесь
 * ровно 256. Пароля восстановления (второго, человеческого пути из design
 * §3/§6.1) в фазе 1 НЕТ вовсе: «выбери один понятный recovery mechanism и
 * реализуй его полностью».
 *
 * Отсюда же следует, почему обёртка SMK идёт через HKDF, а не Argon2id.
 * Argon2id существует, чтобы замедлить перебор ЧЕЛОВЕЧЕСКОГО пароля с
 * низкой энтропией. Против равномерно случайного 256-битного секрета
 * перебор невозможен при любой скорости KDF (2^256), поэтому Argon2id тут
 * не «запас прочности», а работа без цели: она стоила бы секунду на каждом
 * подключении устройства и не закрывала бы ни одной реальной угрозы.
 * Требование design §6.1 (Argon2id + оффлайн-модель угроз) остаётся в силе
 * ровно для того случая, для которого написано, — если пароль когда-нибудь
 * появится как второй путь восстановления (фаза 2).
 */
import { concatBytes, randomBytes, utf8 } from '../util/bytes.js';

/** SMK — 256 бит. Столько же, сколько у ключа AES, который из него растёт. */
export const SMK_LENGTH = 32;

/** Код восстановления — 256 бит CSPRNG (заказчик: «не менее 256»). */
export const RECOVERY_CODE_ENTROPY_BYTES = 32;

/** Контрольная сумма кода — 16 бит: ловит опечатку, не является защитой. */
export const RECOVERY_CODE_CHECKSUM_BYTES = 2;

/** Нонс AES-GCM — 96 бит, случайные (design §8.1). */
export const SYNC_NONCE_LENGTH = 12;

/** Версия схемы доменных строк. Меняется вместе с раскладкой `info`. */
export const SYNC_KEY_SCHEMA_VERSION = 'v1';

export type SyncKeyDomain = 'content' | 'crdt' | 'versions' | 'manifest';

/**
 * Минимум WebCrypto, который нужен этому модулю. Инъекция — ради тестов и
 * платформ, как это уже сделано в `WebCryptoProvider` (`provider.ts`).
 */
export type SubtleLike = Pick<
  SubtleCrypto,
  'importKey' | 'deriveKey' | 'deriveBits' | 'encrypt' | 'decrypt' | 'digest' | 'sign'
>;

function subtleOf(subtle?: SubtleLike): SubtleLike {
  return subtle ?? globalThis.crypto.subtle;
}

/**
 * Доменная строка HKDF. Версионирована и стабильна: изменить её значит
 * сделать нечитаемым всё, что уже зашифровано, — поэтому она собирается
 * ровно здесь и нигде больше.
 */
export function syncKeyInfo(domain: SyncKeyDomain, noteId?: string): string {
  const base = `zapiski/sync/${SYNC_KEY_SCHEMA_VERSION}/${domain}`;
  if (domain === 'manifest') return base;
  if (noteId === undefined || noteId === '') {
    throw new Error(`домен «${domain}» выводится по заметке — нужен noteId`);
  }
  return `${base}/${noteId}`;
}

export function generateSmk(): Uint8Array {
  return randomBytes(SMK_LENGTH);
}

/**
 * Доменный подключ AES-256-GCM из SMK.
 *
 * `accountSalt` — публичная соль аккаунта (та же, что у обёртки SMK, design
 * §2.2). Публичность здесь не уступка: HKDF не требует секретной соли, а
 * общей солью все устройства аккаунта обязаны пользоваться одной и той же,
 * иначе один и тот же SMK дал бы на них РАЗНЫЕ ключи и синк развалился бы.
 */
export async function deriveSyncKey(
  smk: Uint8Array,
  accountSalt: Uint8Array,
  domain: SyncKeyDomain,
  noteId?: string,
  subtle?: SubtleLike,
): Promise<CryptoKey> {
  const api = subtleOf(subtle);
  const base = await api.importKey('raw', smk as BufferSource, 'HKDF', false, ['deriveKey']);
  return api.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: accountSalt as BufferSource,
      info: utf8(syncKeyInfo(domain, noteId)) as BufferSource,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    /* extractable: false — материал ключа не должен уметь покидать WebCrypto,
       тот же принцип, что у ключа заметки (`provider.ts`). */
    false,
    ['encrypt', 'decrypt'],
  );
}

export const deriveContentKey = (
  smk: Uint8Array,
  accountSalt: Uint8Array,
  noteId: string,
  subtle?: SubtleLike,
): Promise<CryptoKey> => deriveSyncKey(smk, accountSalt, 'content', noteId, subtle);

export const deriveCrdtKey = (
  smk: Uint8Array,
  accountSalt: Uint8Array,
  noteId: string,
  subtle?: SubtleLike,
): Promise<CryptoKey> => deriveSyncKey(smk, accountSalt, 'crdt', noteId, subtle);

export const deriveVersionsKey = (
  smk: Uint8Array,
  accountSalt: Uint8Array,
  noteId: string,
  subtle?: SubtleLike,
): Promise<CryptoKey> => deriveSyncKey(smk, accountSalt, 'versions', noteId, subtle);

export const deriveManifestKey = (
  smk: Uint8Array,
  accountSalt: Uint8Array,
  subtle?: SubtleLike,
): Promise<CryptoKey> => deriveSyncKey(smk, accountSalt, 'manifest', undefined, subtle);

// ── Код восстановления ─────────────────────────────────────────────────────

/**
 * Crockford Base32: 32 символа без визуально спутываемых `I`, `L`, `O`, `U`.
 * При разборе `I`/`L` читаются как `1`, `O` — как `0` (правило Крокфорда):
 * человек переписывает код от руки, и «единица вместо I» — не ошибка ввода,
 * а нормальное чтение.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface RecoveryCode {
  /** 256 бит энтропии — то, из чего выводится ключ обёртки. */
  readonly secret: Uint8Array;
  /** 16 бит контрольной суммы — только для проверки опечатки. */
  readonly checksum: Uint8Array;
}

export type RecoveryCodeParse =
  | { ok: true; secret: Uint8Array }
  | { ok: false; reason: 'length' | 'alphabet' | 'checksum' };

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string, byteLength: number): Uint8Array | null {
  const bytes = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = CROCKFORD.indexOf(char);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      if (index >= byteLength) return null;
      bytes[index] = (buffer >> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
  }
  return index === byteLength ? bytes : null;
}

/** Нормализация ввода: регистр, дефисы/пробелы, правило Крокфорда для I/L/O. */
function normalizeRecoveryInput(text: string): string {
  return text
    .toUpperCase()
    .replace(/[\s\-–—_]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/**
 * Контрольная сумма — SHA-256(секрет)[0:2], считается WebCrypto.
 *
 * Своя реализация SHA-256 здесь была бы ошибкой: примитив, который уже есть
 * в платформе и проверен, не переписывают руками ради синхронности вызова.
 * Цена — `parseRecoveryCode` асинхронный; для формы, которая проверяет код
 * при вводе/отправке, это ничего не стоит.
 */
async function checksumOf(secret: Uint8Array, subtle?: SubtleLike): Promise<Uint8Array> {
  const digest = await subtleOf(subtle).digest('SHA-256', secret as BufferSource);
  return new Uint8Array(digest).slice(0, RECOVERY_CODE_CHECKSUM_BYTES);
}

export async function generateRecoveryCode(subtle?: SubtleLike): Promise<RecoveryCode> {
  const secret = randomBytes(RECOVERY_CODE_ENTROPY_BYTES);
  return { secret, checksum: await checksumOf(secret, subtle) };
}

/** Человеку — группами по 5 символов через дефис. */
export function formatRecoveryCode(code: RecoveryCode): string {
  const encoded = base32Encode(concatBytes(code.secret, code.checksum));
  return (encoded.match(/.{1,5}/g) ?? []).join('-');
}

/**
 * Разбор введённого кода. Контрольная сумма проверяется ЛОКАЛЬНО и ДО любого
 * обращения к серверу: опечатка — это опечатка, а не попытка подбора, и она
 * не должна ни ходить по сети, ни тратить бюджет троттлинга (design §6.0).
 */
export async function parseRecoveryCode(text: string, subtle?: SubtleLike): Promise<RecoveryCodeParse> {
  const normalized = normalizeRecoveryInput(text);
  const totalBytes = RECOVERY_CODE_ENTROPY_BYTES + RECOVERY_CODE_CHECKSUM_BYTES;
  const expectedChars = Math.ceil((totalBytes * 8) / 5);
  if (normalized.length !== expectedChars) return { ok: false, reason: 'length' };
  const decoded = base32Decode(normalized, totalBytes);
  if (decoded === null) return { ok: false, reason: 'alphabet' };
  const secret = decoded.slice(0, RECOVERY_CODE_ENTROPY_BYTES);
  const checksum = decoded.slice(RECOVERY_CODE_ENTROPY_BYTES);
  const expected = await checksumOf(secret, subtle);
  for (let i = 0; i < expected.length; i += 1) {
    if (checksum[i] !== expected[i]) return { ok: false, reason: 'checksum' };
  }
  return { ok: true, secret };
}

// ── Обёртка SMK кодом восстановления ───────────────────────────────────────

/**
 * Раскладка обёрнутого блоба: `[версия(1)][нонс(12)][шифротекст+тег GCM]`.
 * Нонс не секрет и лежит рядом с шифротекстом (design §8.1). Версия
 * подписана как AAD: подмена версии не должна молча увести разбор в другую
 * ветку — тот же приём, что уже применён к заголовку контейнера заметки
 * (`container.ts`, «заголовок он же AAD»).
 */
export const WRAPPED_SMK_VERSION = 1;

async function wrapKeyFrom(
  recoverySecret: Uint8Array,
  accountSalt: Uint8Array,
  subtle: SubtleLike,
): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', recoverySecret as BufferSource, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: accountSalt as BufferSource,
      info: utf8(`zapiski/sync/${SYNC_KEY_SCHEMA_VERSION}/recovery-wrap`) as BufferSource,
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapSmk(
  smk: Uint8Array,
  recoverySecret: Uint8Array,
  accountSalt: Uint8Array,
  subtle?: SubtleLike,
): Promise<Uint8Array> {
  const api = subtleOf(subtle);
  const key = await wrapKeyFrom(recoverySecret, accountSalt, api);
  const nonce = randomBytes(SYNC_NONCE_LENGTH);
  const header = new Uint8Array([WRAPPED_SMK_VERSION]);
  const ciphertext = new Uint8Array(
    await api.encrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: header as BufferSource },
      key,
      smk as BufferSource,
    ),
  );
  return concatBytes(header, nonce, ciphertext);
}

/**
 * `null` — код не подошёл, блоб повреждён или обрезан. Никогда не бросает:
 * тот же контракт, что у `decrypt()` заметки (BEHAVIOR §5.2), и по той же
 * причине — неверный секрет это штатный ответ, а не сбой программы.
 */
export async function unwrapSmk(
  wrapped: Uint8Array,
  recoverySecret: Uint8Array,
  accountSalt: Uint8Array,
  subtle?: SubtleLike,
): Promise<Uint8Array | null> {
  if (wrapped.length < 1 + SYNC_NONCE_LENGTH + 16) return null;
  if (wrapped[0] !== WRAPPED_SMK_VERSION) return null;
  const api = subtleOf(subtle);
  const header = wrapped.slice(0, 1);
  const nonce = wrapped.slice(1, 1 + SYNC_NONCE_LENGTH);
  const ciphertext = wrapped.slice(1 + SYNC_NONCE_LENGTH);
  try {
    const key = await wrapKeyFrom(recoverySecret, accountSalt, api);
    const plain = await api.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: header as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}
