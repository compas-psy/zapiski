/**
 * Яндекс ID (OAuth) — основной путь входа (ТЗ §5.5).
 *
 * Бесплатен для нас и не требует SMS. Секреты берутся только из окружения:
 * YANDEX_CLIENT_ID / YANDEX_CLIENT_SECRET / YANDEX_REDIRECT_URI.
 */

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const INFO_URL = 'https://login.yandex.ru/info?format=json';

export interface YandexConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface YandexIdentity {
  /** Стабильный идентификатор аккаунта Яндекса. */
  id: string;
  email: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class YandexOAuthError extends Error {
  readonly stage: 'token' | 'info' | 'email';

  constructor(stage: 'token' | 'info' | 'email', message: string) {
    super(message);
    this.name = 'YandexOAuthError';
    this.stage = stage;
  }
}

export class YandexOAuth {
  readonly #config: YandexConfig;
  readonly #fetch: FetchLike;

  constructor(config: YandexConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  authorizeUrl(state: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.#config.clientId);
    url.searchParams.set('redirect_uri', this.#config.redirectUri);
    url.searchParams.set('state', state);
    // login:email нужен, чтобы завести аккаунт; больше ничего не запрашиваем.
    url.searchParams.set('scope', 'login:email login:info');
    return url.toString();
  }

  async exchange(code: string): Promise<YandexIdentity> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.#config.clientId,
      client_secret: this.#config.clientSecret,
    });

    const tokenResponse = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!tokenResponse.ok) {
      throw new YandexOAuthError('token', `Яндекс вернул ${tokenResponse.status} на обмен кода`);
    }
    const token = (await tokenResponse.json()) as { access_token?: unknown };
    if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
      throw new YandexOAuthError('token', 'Яндекс не вернул access_token');
    }

    const infoResponse = await this.#fetch(INFO_URL, {
      headers: { authorization: `OAuth ${token.access_token}` },
    });
    if (!infoResponse.ok) {
      throw new YandexOAuthError('info', `Яндекс вернул ${infoResponse.status} на запрос профиля`);
    }
    const info = (await infoResponse.json()) as {
      id?: unknown;
      default_email?: unknown;
      emails?: unknown;
    };

    const id = typeof info.id === 'string' ? info.id : String(info.id ?? '');
    if (id.length === 0) throw new YandexOAuthError('info', 'Яндекс не вернул идентификатор');

    const email = pickEmail(info);
    if (email === null) {
      throw new YandexOAuthError('email', 'В аккаунте Яндекса не нашлось адреса почты');
    }

    return { id, email };
  }
}

function pickEmail(info: { default_email?: unknown; emails?: unknown }): string | null {
  if (typeof info.default_email === 'string' && info.default_email.includes('@')) {
    return info.default_email;
  }
  if (Array.isArray(info.emails)) {
    const first = info.emails.find((e): e is string => typeof e === 'string' && e.includes('@'));
    if (first !== undefined) return first;
  }
  return null;
}
