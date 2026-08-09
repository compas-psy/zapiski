/**
 * Контейнер `.md.enc` (ТЗ §3.3): magic `ZPSK` + версия + salt + nonce +
 * AES-256-GCM payload + опциональная подсказка к паролю.
 *
 * Раскладка (little-endian):
 *
 * ```
 *  0  4  magic      'ZPSK'
 *  4  1  version    1
 *  5  1  flags      бит 0 — есть подсказка
 *  6  1  saltLen
 *  7  1  nonceLen
 *  8  2  hintLen    (0, если подсказки нет)
 * 10  .. salt
 *    .. nonce
 *    .. hint (UTF-8, открытым текстом — намеренно, contract.ts)
 *    .. ciphertext + тег GCM
 * ```
 */
import type { EncryptedContainer } from '../contract.js';
import { concatBytes, utf8, fromUtf8 } from '../util/bytes.js';

export const MAGIC = 'ZPSK';
export const CONTAINER_VERSION = 1;
export const SALT_LENGTH = 16;
export const NONCE_LENGTH = 12;
const HEADER_LENGTH = 10;
const MAGIC_BYTES = utf8(MAGIC);

export function encodeContainer(container: EncryptedContainer): Uint8Array {
  const hintBytes = container.hint === undefined ? new Uint8Array(0) : utf8(container.hint);
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(MAGIC_BYTES, 0);
  header[4] = container.version;
  header[5] = container.hint === undefined ? 0 : 1;
  header[6] = container.salt.length;
  header[7] = container.nonce.length;
  header[8] = hintBytes.length & 0xff;
  header[9] = (hintBytes.length >> 8) & 0xff;
  return concatBytes(header, container.salt, container.nonce, hintBytes, container.ciphertext);
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
  let offset = HEADER_LENGTH;
  const end = offset + saltLength + nonceLength + hintLength;
  if (saltLength === 0 || nonceLength === 0 || end > data.length) return null;
  const salt = data.slice(offset, (offset += saltLength));
  const nonce = data.slice(offset, (offset += nonceLength));
  const hint = (flags & 1) === 1 ? fromUtf8(data.slice(offset, (offset += hintLength))) : undefined;
  const ciphertext = data.slice(offset);
  // Пустой payload невозможен: GCM всегда добавляет 16-байтовый тег.
  if (ciphertext.length < 16) return null;
  const container: EncryptedContainer = { magic: MAGIC, version, salt, nonce, ciphertext };
  if (hint !== undefined) container.hint = hint;
  return container;
}

export function looksEncrypted(data: Uint8Array): boolean {
  if (data.length < MAGIC_BYTES.length) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i += 1) if (data[i] !== MAGIC_BYTES[i]) return false;
  return true;
}
