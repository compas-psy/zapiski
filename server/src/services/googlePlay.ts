import { createSign } from 'node:crypto';

import type { FetchLike } from './yandex.ts';

/**
 * Серверная валидация покупок Google Play Billing (ТЗ §5.5).
 *
 * Клиент присылает purchaseToken, сервер сам ходит в Google Play Developer API
 * — доверять результату проверки на устройстве нельзя. Доступ по сервисному
 * аккаунту: собираем RS256-JWT, меняем его на access_token, читаем
 * `purchases/subscriptionsv2/tokens/{token}`.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface GooglePlayConfig {
  packageName: string;
  serviceAccountEmail: string;
  /** PEM приватного ключа сервисного аккаунта. */
  privateKey: string;
}

export interface PlayPurchase {
  /** Подписка активна прямо сейчас. */
  active: boolean;
  productId: string;
  expiryTime: Date;
  startTime: Date;
  autoRenewing: boolean;
  /** Google-идентификатор покупки — для идемпотентности вебхуков. */
  orderId: string | null;
  /** Связка нескольких устройств одного аккаунта. */
  linkedPurchaseToken: string | null;
}

export interface PlayVerifier {
  verifySubscription(purchaseToken: string): Promise<PlayPurchase>;
}

export class PlayVerificationError extends Error {
  readonly stage: 'auth' | 'api' | 'payload';

  constructor(stage: 'auth' | 'api' | 'payload', message: string) {
    super(message);
    this.name = 'PlayVerificationError';
    this.stage = stage;
  }
}

export class GooglePlayVerifier implements PlayVerifier {
  readonly #config: GooglePlayConfig;
  readonly #fetch: FetchLike;
  #cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(config: GooglePlayConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async verifySubscription(purchaseToken: string): Promise<PlayPurchase> {
    const accessToken = await this.#accessToken();
    const url = `${API_BASE}/${encodeURIComponent(this.#config.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const response = await this.#fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new PlayVerificationError('api', `Google Play вернул ${response.status}`);
    }
    return parseSubscriptionV2(await response.json());
  }

  async #accessToken(): Promise<string> {
    const now = Date.now();
    if (this.#cachedToken !== null && this.#cachedToken.expiresAt > now + 60_000) {
      return this.#cachedToken.value;
    }

    const assertion = this.#signAssertion(now);
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      throw new PlayVerificationError('auth', `Google OAuth вернул ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') {
      throw new PlayVerificationError('auth', 'Google OAuth не вернул access_token');
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.#cachedToken = { value: body.access_token, expiresAt: now + ttl * 1000 };
    return body.access_token;
  }

  #signAssertion(nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({
        iss: this.#config.serviceAccountEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const input = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256')
      .update(input)
      .sign(normalizePem(this.#config.privateKey))
      .toString('base64url');
    return `${input}.${signature}`;
  }
}

const ACTIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  'SUBSCRIPTION_STATE_CANCELED', // отменена, но оплаченный период ещё идёт
]);

/** Разбор ответа `subscriptionsv2`. Вынесен отдельно, чтобы покрыть тестом. */
export function parseSubscriptionV2(raw: unknown): PlayPurchase {
  if (typeof raw !== 'object' || raw === null) {
    throw new PlayVerificationError('payload', 'Google Play вернул пустой ответ');
  }
  const body = raw as {
    subscriptionState?: unknown;
    startTime?: unknown;
    latestOrderId?: unknown;
    linkedPurchaseToken?: unknown;
    lineItems?: unknown;
  };

  const items = Array.isArray(body.lineItems) ? body.lineItems : [];
  const item = items[0] as
    | { productId?: unknown; expiryTime?: unknown; autoRenewingPlan?: { autoRenewEnabled?: unknown } }
    | undefined;
  if (item === undefined) {
    throw new PlayVerificationError('payload', 'В ответе Google Play нет позиций подписки');
  }

  const expiry = typeof item.expiryTime === 'string' ? new Date(item.expiryTime) : null;
  if (expiry === null || Number.isNaN(expiry.getTime())) {
    throw new PlayVerificationError('payload', 'В ответе Google Play нет срока действия');
  }

  const state = typeof body.subscriptionState === 'string' ? body.subscriptionState : '';
  const start =
    typeof body.startTime === 'string' && !Number.isNaN(Date.parse(body.startTime))
      ? new Date(body.startTime)
      : new Date();

  return {
    active: ACTIVE_STATES.has(state) && expiry.getTime() > Date.now(),
    productId: typeof item.productId === 'string' ? item.productId : '',
    expiryTime: expiry,
    startTime: start,
    autoRenewing: item.autoRenewingPlan?.autoRenewEnabled === true,
    orderId: typeof body.latestOrderId === 'string' ? body.latestOrderId : null,
    linkedPurchaseToken:
      typeof body.linkedPurchaseToken === 'string' ? body.linkedPurchaseToken : null,
  };
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** В .env перенос строки часто приезжает как литерал `\n`. */
function normalizePem(key: string): string {
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}
