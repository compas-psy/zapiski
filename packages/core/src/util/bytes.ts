/**
 * Байтовые утилиты ядра. Никаких node-специфичных API — код исполняется
 * байт-в-байт одинаково в вебе, Tauri desktop и Tauri Android (ADR-0001).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function fromUtf8(data: Uint8Array): string {
  return decoder.decode(data);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const HEX = '0123456789abcdef';

export function toHex(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] as number;
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * FNV-1a 32 бит. Используется там, где нужен быстрый неверифицируемый хеш:
 * имена вложений (ТЗ §3.2), идентификаторы снапшотов.
 */
export function fnv1a(input: string | Uint8Array): number {
  const data = typeof input === 'string' ? utf8(input) : input;
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i] as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Короткий хеш содержимого для имени вложения: `2026-08-08_1a2b3c.png`. */
export function shortHash(data: Uint8Array): string {
  const forward = fnv1a(data);
  // Второй проход по перевёрнутым байтам: без него палиндромные данные
  // («2 2», «1») давали бы один и тот же хеш.
  let backward = 0x811c9dc5;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    backward ^= data[i] as number;
    backward = Math.imul(backward, 0x01000193) >>> 0;
  }
  const mixed = (forward ^ Math.imul(backward ^ data.length, 0x85ebca6b)) >>> 0;
  return mixed.toString(16).padStart(8, '0').slice(0, 6);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i] as number;
    const b1 = i + 1 < data.length ? (data[i + 1] as number) : 0;
    const b2 = i + 2 < data.length ? (data[i + 2] as number) : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < data.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < data.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i] as string);
    const c1 = B64.indexOf(clean[i + 1] ?? 'A');
    const c2 = B64.indexOf(clean[i + 2] ?? 'A');
    const c3 = B64.indexOf(clean[i + 3] ?? 'A');
    out[outIndex] = (c0 << 2) | (c1 >> 4);
    outIndex += 1;
    if (i + 2 < clean.length) {
      out[outIndex] = ((c1 & 15) << 4) | (c2 >> 2);
      outIndex += 1;
    }
    if (i + 3 < clean.length) {
      out[outIndex] = ((c2 & 3) << 6) | c3;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

/** Уникальный идентификатор заметки (ТЗ §3.2, поле `id` во frontmatter). */
export function newId(): string {
  return toHex(randomBytes(12));
}
