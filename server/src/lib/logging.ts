import type { FastifyReply, FastifyRequest } from 'fastify';

import { shortHash } from './crypto.ts';

/**
 * Логи и приватность (ТЗ §6).
 *
 * В журнал не попадает ни содержимое заметок (его у сервера нет вовсе), ни
 * пути внутри vault'а — путь несёт заголовок заметки и имена папок, то есть
 * это тоже пользовательские данные. Вместо пути пишется короткий хеш: его
 * хватает, чтобы связать строки одного инцидента, и он ничего не раскрывает.
 *
 * Заодно вычищаются секреты из query (`token`, `code`, `access_token`) и
 * адрес почты — по нему пользователь опознаётся однозначно.
 */

/** Префиксы, всё после которых — пользовательские данные. */
const OPAQUE_PREFIXES = [
  '/api/v1/vault/blob/',
  '/api/v1/vault/crdt/',
  '/api/v1/vault/versions/',
];

const SECRET_QUERY_KEYS = new Set([
  'token',
  'code',
  'access_token',
  'refresh_token',
  'email',
  'state',
]);

/** Приводит URL к виду, безопасному для журнала. */
export function sanitizeUrl(rawUrl: string): string {
  const [pathnameRaw = '', queryRaw] = splitOnce(rawUrl, '?');
  let pathname = pathnameRaw;

  for (const prefix of OPAQUE_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const rest = pathname.slice(prefix.length);
      pathname = rest.length > 0 ? `${prefix}#${shortHash(rest)}` : prefix;
      break;
    }
  }

  // Слаг публичной страницы — тоже адрес пользовательского материала.
  if (pathname.startsWith('/p/')) {
    pathname = `/p/#${shortHash(pathname.slice(3))}`;
  }

  if (queryRaw === undefined) return pathname;

  const parts = queryRaw.split('&').map((pair) => {
    const [key = '', value] = splitOnce(pair, '=');
    if (value === undefined) return key;
    return SECRET_QUERY_KEYS.has(key.toLowerCase()) ? `${key}=[скрыто]` : pair;
  });

  return `${pathname}?${parts.join('&')}`;
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

export interface SerializedRequest {
  [key: string]: unknown;
  method: string;
  url: string;
  remoteAddressHash?: string;
}

export const serializers = {
  req(request: FastifyRequest): SerializedRequest {
    const out: SerializedRequest = {
      method: request.method,
      url: sanitizeUrl(request.url),
    };
    // IP — персональные данные; для корреляции достаточно хеша.
    if (request.ip) out.remoteAddressHash = shortHash(request.ip);
    return out;
  },
  // Тип параметра намеренно минимален: pino отдаёт сюда обёртку над reply,
  // а не сам FastifyReply, и точный тип у неё меняется от версии к версии.
  res(reply: { statusCode: number }): { [key: string]: unknown; statusCode: number } {
    return { statusCode: reply.statusCode };
  },
};

/** Заголовки, которые никогда не должны оказаться в журнале целиком. */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.RebillId',
  '*.rebillId',
  'req.headers["sec-websocket-key"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.ciphertext',
  '*.html',
];
