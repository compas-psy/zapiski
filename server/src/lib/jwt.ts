import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Минимальный JWT HS256 на node:crypto.
 *
 * Своя реализация вместо зависимости — 60 строк, полностью читаемых на аудите
 * крипто-модуля (ТЗ §6 «Безопасность»), без транзитивных зависимостей.
 * Поддерживается ровно один алгоритм: HS256. Токены с `alg: none` или любым
 * другим `alg` отвергаются — классическая дыра реализаций JWT.
 */

export interface JwtClaims {
  /** user id */
  sub: string;
  /** session id */
  sid: string;
  /** device id (внутренний uuid устройства) */
  did: string;
  typ: 'access' | 'oauth_state';
  iat: number;
  exp: number;
  /** Свободные поля для короткоживущего state OAuth. */
  [key: string]: unknown;
}

export type SignableClaims = Omit<JwtClaims, 'iat' | 'exp'> & Record<string, unknown>;

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

/**
 * `nowMs` передаётся явно, а не берётся из `Date.now()`: подпись и проверка
 * обязаны смотреть на одни и те же часы. Иначе тест с управляемым временем
 * (и любая будущая логика на смещённых часах) получает токен «из будущего».
 */
export function signJwt(
  claims: SignableClaims,
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  const payload: JwtClaims = { ...claims, iat: now, exp: now + ttlSeconds } as JwtClaims;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${HEADER}.${body}`;
  return `${signingInput}.${hmac(signingInput, secret)}`;
}

export type JwtVerifyFailure =
  | 'malformed'
  | 'bad_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid';

export type JwtVerifyResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: JwtVerifyFailure };

export function verifyJwt(token: string, secret: string, nowMs = Date.now()): JwtVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [rawHeader, rawBody, rawSig] = parts as [string, string, string];

  let header: unknown;
  let claims: unknown;
  try {
    header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(rawBody, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof header !== 'object' ||
    header === null ||
    (header as { alg?: unknown }).alg !== 'HS256'
  ) {
    return { ok: false, reason: 'bad_algorithm' };
  }

  const expected = hmac(`${rawHeader}.${rawBody}`, secret);
  const a = Buffer.from(rawSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (typeof claims !== 'object' || claims === null) return { ok: false, reason: 'malformed' };
  const c = claims as JwtClaims;
  if (typeof c.exp !== 'number' || typeof c.iat !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= c.exp) return { ok: false, reason: 'expired' };
  // Допуск 60 с на расхождение часов между узлами.
  if (nowSec + 60 < c.iat) return { ok: false, reason: 'not_yet_valid' };

  return { ok: true, claims: c };
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}
