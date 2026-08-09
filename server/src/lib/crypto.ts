import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Криптографически стойкий непрозрачный токен (base64url без паддинга). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 в hex. Токены и refresh-токены хранятся только в виде хеша. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/** Короткий стабильный хеш — для логов, где нельзя писать сам путь (ТЗ §6). */
export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 12);
}

/** Сравнение секретов без утечки по времени. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Всё равно делаем сравнение, чтобы длина не читалась по таймингу.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * ETag содержимого блоба: сильный валидатор по SHA-256 шифротекста.
 * Сервер не знает, что внутри, — считает хеш от байтов как есть.
 */
export function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('base64url')}"`;
}

/** Нормализация значения If-Match: снимаем W/ и лишние кавычки. */
export function normalizeEtag(value: string): string {
  const trimmed = value.trim().replace(/^W\//, '');
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed;
  return `"${trimmed}"`;
}

/** Slug для публичной страницы: 12 символов base32-подобного алфавита. */
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function randomSlug(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SLUG_ALPHABET[bytes[i]! % SLUG_ALPHABET.length];
  }
  return out;
}
