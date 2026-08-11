/**
 * Контейнер `.md.enc` (ТЗ §3.3): magic `ZPSK` + версия + salt + nonce +
 * идентификатор ключа заметки + AES-256-GCM payload + опциональная подсказка.
 *
 * Раскладка (little-endian):
 *
 * ```
 *  0  4  magic      'ZPSK'
 *  4  1  version    1 | 2
 *  5  1  flags      бит 0 — есть подсказка, бит 1 — есть keyId
 *  6  1  saltLen
 *  7  1  nonceLen
 *  8  2  hintLen    (0, если подсказки нет)
 * 10  .. salt
 *    .. nonce
 *    .. keyId (16 байт, только версия 2)
 *    .. hint (UTF-8, открытым текстом — намеренно, contract.ts)
 *    .. ciphertext + тег GCM
 * ```
 *
 * ── Зачем версия 2 и `keyId` ────────────────────────────────────────────────
 *
 * Версия 1 шифровала заметку ключом, выведенным прямо из пароля: у каждой
 * заметки свой пароль и свой прогон Argon2id при каждом открытии. ТЗ §3.3
 * требует иерархию «пароль → master key → per-note keys», и версия 2 её
 * выполняет: ключ заметки выводится HKDF из master по `keyId`.
 *
 * `keyId` — 16 случайных байт, а НЕ путь и не идентификатор заметки. Причина
 * не в криптографии, а в продукте: файл здесь переименовывает себя сам, по
 * заголовку, через две секунды после набора (BEHAVIOR §2.2). Ключ, выведенный
 * из пути, после первого же переименования перестал бы открывать собственную
 * заметку. `keyId` лежит в заголовке открытым текстом — он ничего не выдаёт:
 * это случайное число, одинаковое только для одной заметки.
 *
 * Версия 1 читается по-прежнему и никогда не пишется: см. `provider.ts`.
 */
import type { EncryptedContainer } from '../contract.js';
import { concatBytes, utf8, fromUtf8 } from '../util/bytes.js';

export const MAGIC = 'ZPSK';
/** Версия, которую пишем. Версия 1 остаётся читаемой (иерархии в ней нет). */
export const CONTAINER_VERSION = 2;
export const LEGACY_CONTAINER_VERSION = 1;
export const SALT_LENGTH = 16;
export const NONCE_LENGTH = 12;
export const KEY_ID_LENGTH = 16;
const FLAG_HINT = 1;
const FLAG_KEY_ID = 2;
const HEADER_LENGTH = 10;
const MAGIC_BYTES = utf8(MAGIC);

/**
 * Заголовок без шифротекста — он же AAD (ТЗ §3.3, «zero-knowledge»).
 *
 * Соль, nonce, `keyId` и подсказка лежат открытым текстом и потому уязвимы для
 * подмены: GCM защищает только payload. Подмена `keyId` заставила бы
 * приложение вывести другой ключ, подмена подсказки — показать человеку чужой
 * текст под видом своей подсказки. Поэтому заголовок целиком подписывается
 * тегом GCM как additional authenticated data: изменение любого его байта
 * делает расшифровку невозможной, а не «просто другой».
 */
export function encodeHeader(container: Omit<EncryptedContainer, 'ciphertext'>): Uint8Array {
  const hintBytes = container.hint === undefined ? new Uint8Array(0) : utf8(container.hint);
  const keyId = container.keyId ?? new Uint8Array(0);
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC_BYTES, 0);
  header[4] = container.version;
  header[5] = (container.hint === undefined ? 0 : FLAG_HINT) | (keyId.length > 0 ? FLAG_KEY_ID : 0);
  header[6] = container.salt.length;
  header[7] = container.nonce.length;
  header[8] = hintBytes.length & 0xff;
  header[9] = (hintBytes.length >> 8) & 0xff;
  return concatBytes(header, container.salt, container.nonce, keyId, hintBytes);
}

export function encodeContainer(container: EncryptedContainer): Uint8Array {
  return concatBytes(encodeHeader(container), container.ciphertext);
}

/**
 * Разбор контейнера. Любая порча — `null`, без исключений: повреждённый файл
 * не должен ронять приложение (BEHAVIOR §11, «Не удалось прочитать файл»).
 */
export function decodeContainer(data: Uint8Array): EncryptedContainer | null {
  if (data.length < HEADER_LENGTH) return null;
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) if (data[i] !== MAGIC_BYTES[i]) return null;
  const version = data[4] as number;
  const flags = data[5] as number;
  const saltLength = data[6] as number;
  const nonceLength = data[7] as number;
  const hintLength = (data[8] as number) | ((data[9] as number) << 8);
  const keyIdLength = (flags & FLAG_KEY_ID) === FLAG_KEY_ID ? KEY_ID_LENGTH : 0;
  let offset = HEADER_LENGTH;
  const end = offset + saltLength + nonceLength + keyIdLength + hintLength;
  if (saltLength === 0 || nonceLength === 0 || end > data.length) return null;
  const salt = data.slice(offset, (offset += saltLength));
  const nonce = data.slice(offset, (offset += nonceLength));
  const keyId = keyIdLength > 0 ? data.slice(offset, (offset += keyIdLength)) : undefined;
  const hint =
    (flags & FLAG_HINT) === FLAG_HINT ? fromUtf8(data.slice(offset, (offset += hintLength))) : undefined;
  const ciphertext = data.slice(offset);
  // Пустой payload невозможен: GCM всегда добавляет 16-байтовый тег.
  if (ciphertext.length < 16) return null;
  const container: EncryptedContainer = { magic: MAGIC, version, salt, nonce, ciphertext };
  if (keyId !== undefined) container.keyId = keyId;
  if (hint !== undefined) container.hint = hint;
  /* Байты заголовка как они лежат в файле: ими подписан шифротекст. Берём
     срезом, а не пересборкой, — пересобранный заголовок совпал бы с исходным
     не всегда, и подпись перестала бы сходиться на ровном месте. */
  container.aad = data.slice(0, offset);
  return container;
}

export function looksEncrypted(data: Uint8Array): boolean {
  if (data.length < MAGIC_BYTES.length) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) if (data[i] !== MAGIC_BYTES[i]) return false;
  return true;
}
