import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { createSimpasClient, type SimpasClient } from '@simpas/id-client';

import type { Env } from '../config/env.ts';

/**
 * Единый вход СИМПАС (`auth.cmpas.ru`) — рецепт `compas-psy/auth`,
 * `docs/integration/zapiski.md`.
 *
 * Обмен кода, проверка подписи id_token и сверка nonce делаются ИХ SDK, а не
 * своим `fetch` к `/token`. Это прямое требование рецепта, и оно разумное:
 * именно в этих трёх шагах ошибаются, а ошибка выглядит как работающий вход.
 */

/** `null` — вход не настроен. Признак один: наличие ключа клиента. */
export function createSimpas(env: Env): SimpasClient | null {
  const secret = env.SIMPASID_CLIENT_SECRET;
  if (secret === undefined || secret === '') return null;
  return createSimpasClient({
    issuer: env.SIMPASID_ISSUER,
    clientId: env.SIMPASID_CLIENT_ID,
    clientSecret: secret,
  });
}

/** Адрес возврата: заданный явно либо собранный из `PUBLIC_BASE_URL`. */
export function simpasRedirectUri(env: Env): string {
  return (
    env.SIMPASID_REDIRECT_URI ??
    `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/auth/simpas/callback`
  );
}

/**
 * ── Почему PKCE-верификатор запечатывается, а не едет открытым ────────────
 *
 * Состояние OAuth у нас ездит подписанным JWT, а не лежит в таблице — так уже
 * сделано у Яндекса, и заводить таблицу ради одного круга не хочется.
 * Но подпись содержимое НЕ ПРЯЧЕТ: payload JWT читается кем угодно.
 *
 * Верификатор PKCE — секрет по определению: он доказывает, что код обменивает
 * тот же клиент, который его запрашивал. Положить его в читаемый state значило
 * бы отдать его вместе с кодом любому, кто увидел адрес возврата, и PKCE
 * перестал бы что-либо доказывать. Формально нас прикрывает `client_secret`
 * (клиент конфиденциальный), но защита, которую мы объявили и не обеспечили,
 * хуже отсутствующей.
 *
 * Поэтому верификатор едет запечатанным AES-256-GCM на ключе, выведенном из
 * `AUTH_SECRET`. Наружу он не читается, а на возврате открывается тем же
 * сервером — состояние остаётся stateless.
 */
const NONCE_BYTES = 12;

function keyOf(authSecret: string): Buffer {
  /* Отдельное назначение — отдельный ключ: тот же `AUTH_SECRET` подписывает
     access-JWT, и использовать его байты напрямую для шифра значит смешать
     две роли одного секрета. */
  return createHash('sha256').update(`simpas-pkce:${authSecret}`).digest();
}

export function sealVerifier(verifier: string, authSecret: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyOf(authSecret), nonce);
  const body = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url');
}

/** `null` — подделка, порча или чужой секрет. Все три неразличимы намеренно. */
export function openVerifier(sealed: string, authSecret: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.byteLength <= NONCE_BYTES + 16) return null;
    const nonce = raw.subarray(0, NONCE_BYTES);
    const body = raw.subarray(NONCE_BYTES, raw.byteLength - 16);
    const tag = raw.subarray(raw.byteLength - 16);
    const decipher = createDecipheriv('aes-256-gcm', keyOf(authSecret), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
