/**
 * Сессия Облака Записок: устройство, токены, их обновление и выход.
 *
 * Здесь нет ни одной платформенной детали — всё, что нужно, приходит через
 * `AppHost` (contract.ts): `prefs` для хранения и `cloudBaseUrl` для запросов.
 * Поэтому один и тот же код работает в вебе, на Windows и на Android.
 *
 * Правила, которые этот файл обязан держать:
 *  • токен не попадает ни в журнал, ни в адресную строку — он живёт только
 *    в `prefs` и в заголовке `Authorization`;
 *  • access-токен короткий, refresh — длинный; обновление происходит само,
 *    по истечении, и пользователь его не видит (ТЗ §5.5);
 *  • ни одного SMS-пути: вход — только Яндекс ID и magic-link;
 *  • отсутствие сессии не мешает работать локально — аккаунт нужен ТОЛЬКО
 *    для облака.
 */
import { LEGAL_VERSION } from '@zapiski/core';

import type { AppHost, AuthCallback } from '../contract.js';

/**
 * Согласия, с которыми человек входит.
 *
 * Обязательного здесь нет намеренно: без него до входа дело не доходит вовсе
 * — кнопка неактивна. Поле одно, и это добровольное согласие на рассылку.
 */
export interface Consents {
  marketing: boolean;
}

/** Ключи в `PreferencesStore`. Значения — вне vault'а, как и прочие настройки. */
export const AUTH_PREF = {
  session: 'auth.session',
  device: 'auth.deviceId',
} as const;

/**
 * Машинные коды отказа. Текст для человека подставляет контроллер из реестра
 * BEHAVIOR §11 — в этом файле пользовательских строк нет и быть не должно.
 */
export type AuthErrorCode =
  /** Ссылка просрочена, использована или пришла с другого устройства. */
  | 'link_dead'
  /** Пользователь отказался в Яндекс ID либо OAuth не сложился. */
  | 'declined'
  /** Письмо уже уходило меньше 60 с назад (SCREENS §2). */
  | 'too_soon'
  /** Сети нет или сервер не ответил. */
  | 'unreachable'
  /**
   * Письмо со ссылкой не ушло: наша часть отработала, не ответил почтовый
   * релей. Отдельный код, потому что и причина, и следующий шаг другие: вход
   * через Яндекс ID от почты не зависит и работает.
   */
  | 'mail_failed'
  /** Сервер ответил, но не тем. */
  | 'server';

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = 'AuthError';
  }
}

/** Сессия, как она лежит в `prefs`. Ничего лишнего: только то, что нужно. */
export interface CloudSession {
  /** Согласие на рекламные письма — как оно записано на сервере. */
  marketingOptIn?: boolean;
  /** Согласие на продуктовую аналитику (O-260817-05) — как оно записано на сервере. */
  analyticsOptIn?: boolean;
  accessToken: string;
  refreshToken: string;
  /** Абсолютный момент истечения access-токена, мс эпохи. */
  expiresAt: number;
  userId: string;
  email: string;
  deviceId: string;
}

/** Ответ `server/src/routes/auth.ts` — форма проверена его тестами. */
interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  user: { id: string; email: string; analyticsOptIn: boolean };
  device: { id: string };
}

/** Тело ошибки сервера: код машинный, текст — из того же реестра §11. */
interface ServerErrorBody {
  error?: { code?: string; message?: string };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionStoreOptions {
  fetch?: FetchLike;
  now?: () => number;
  /** Платформа — сервер записывает её к устройству (`web`/`windows`/`android`). */
  platform?: 'web' | 'windows' | 'android';
}

/**
 * Обновляем не в последнюю секунду: запрос, начатый за 30 с до истечения,
 * успеет дойти даже по плохой сети.
 */
const REFRESH_MARGIN_MS = 30_000;

export class SessionStore {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly platform: 'web' | 'windows' | 'android';
  private session: CloudSession | null = null;
  private device: string | null = null;
  /** Одно обновление на все параллельные запросы: иначе refresh-токен гонится. */
  private refreshing: Promise<CloudSession | null> | null = null;

  constructor(
    private readonly host: AppHost,
    options: SessionStoreOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? host.platform.kind;
  }

  /** Уже известная сессия без обращения к диску и сети. */
  current(): CloudSession | null {
    return this.session;
  }

  /** Прочитать сессию из настроек. Вызывается один раз на старте. */
  async load(): Promise<CloudSession | null> {
    const stored = await this.host.prefs.get<CloudSession | null>(AUTH_PREF.session, null);
    this.session = isSession(stored) ? stored : null;
    if (this.session !== null) this.device = this.session.deviceId;
    return this.session;
  }

  /**
   * Идентификатор устройства: постоянный, случайный и ничего о человеке не
   * говорящий. Формат согласован с сервером (`isValidDeviceKey`:
   * `[A-Za-z0-9_.:-]{8,128}`).
   */
  async deviceId(): Promise<string> {
    if (this.device !== null) return this.device;
    const stored = await this.host.prefs.get<string | null>(AUTH_PREF.device, null);
    if (typeof stored === 'string' && /^[A-Za-z0-9_.:-]{8,128}$/.test(stored)) {
      this.device = stored;
      return stored;
    }
    const fresh = `dev-${randomHex(16)}`;
    await this.host.prefs.set(AUTH_PREF.device, fresh);
    this.device = fresh;
    return fresh;
  }

  // ── Вход ───────────────────────────────────────────────────────────────────

  /**
   * Письмо со ссылкой. `deviceId` обязателен: сервер привязывает токен к
   * устройству инициации, и без него ссылка не обменяется ни на одном экране.
   */
  async requestMagicLink(email: string, consents: Consents): Promise<void> {
    const deviceId = await this.deviceId();
    const response = await this.send(`${this.base}/auth/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        deviceId,
        platform: this.platform,
        /* Редакция, а не «да»: согласие даётся на конкретный текст, и
           показанная человеку редакция обязана совпасть с отправленной. */
        acceptedTerms: LEGAL_VERSION,
        marketingOptIn: consents.marketing,
      }),
    });
    if (response.status === 429) throw new AuthError('too_soon');
    /* Причина отказа читается из тела: «письмо не ушло» и «сервер не ответил»
       требуют разных слов и разных следующих шагов. */
    if (!response.ok) throw new AuthError(codeOf(await errorCode(response)));
  }

  /** Адрес, который оболочка открывает во внешнем браузере для Яндекс ID. */
  async yandexUrl(consents: Consents): Promise<string> {
    const deviceId = await this.deviceId();
    const query = new URLSearchParams({
      device_id: deviceId,
      platform: this.platform,
      terms: LEGAL_VERSION,
      marketing: consents.marketing ? '1' : '0',
    });
    return `${this.base}/auth/yandex?${query.toString()}`;
  }

  /**
   * Умеет ли сервер вход через Яндекс.
   *
   * Спрашивается затем, чтобы не показывать кнопку, ведущую в тупик: без
   * client_id сервер отвечает 404, а человек к этому моменту уже в системном
   * браузере и видит голый JSON. Недоступность сети — не повод прятать
   * кнопку: за ней всё равно откроется браузер, и разбираться с оффлайном
   * будет он, поэтому здесь `true`.
   */
  async yandexAvailable(): Promise<boolean> {
    try {
      const response = await this.send(`${this.base}/auth/methods`, { method: 'GET' });
      if (!response.ok) return false;
      const body = (await response.json()) as { yandex?: unknown };
      return body.yandex === true;
    } catch {
      return true;
    }
  }

  /**
   * Дать или отозвать согласие на рекламные письма. Возвращает то, что
   * записано на сервере, а не то, что нажали: тумблер обязан показывать факт.
   */
  async setMarketingConsent(optIn: boolean): Promise<boolean> {
    const token = await this.accessToken();
    if (token === null) throw new AuthError('server');
    const response = await this.send(`${this.base}/auth/marketing-consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ optIn }),
    });
    if (!response.ok) throw new AuthError('server');
    const body = (await response.json()) as { marketingOptIn?: unknown };
    return body.marketingOptIn === true;
  }

  /**
   * Дать или отозвать согласие на продуктовую аналитику (ТЗ §6, O-260817-05).
   * Тот же принцип, что у рекламного согласия: показываем то, что записал
   * сервер, не то, что нажали.
   */
  async setAnalyticsConsent(optIn: boolean): Promise<boolean> {
    const token = await this.accessToken();
    if (token === null) throw new AuthError('server');
    const response = await this.send(`${this.base}/auth/analytics-consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ optIn }),
    });
    if (!response.ok) throw new AuthError('server');
    const body = (await response.json()) as { analyticsOptIn?: unknown };
    return body.analyticsOptIn === true;
  }

  /**
   * Начать оплату подписки через Т-Банк.
   *
   * Возвращает адрес платёжной формы банка. Открывает его оболочка —
   * системным браузером, а не внутри окна: форма оплаты чужая, и показывать
   * её в своём WebView значит просить у человека номер карты «внутри
   * приложения».
   *
   * Отказ здесь — это отказ СОЗДАТЬ платёж, а не отказ оплаты: денег ещё
   * никто не трогал, и человеку надо сказать именно это.
   */
  async startPayment(plan: 'monthly' | 'yearly', returnUrl: string): Promise<string> {
    const token = await this.accessToken();
    if (token === null) throw new AuthError('server');
    const response = await this.send(`${this.base}/billing/tbank/payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan, returnUrl }),
    });
    if (!response.ok) throw new AuthError('server');
    const body = (await response.json()) as { confirmationUrl?: unknown };
    if (typeof body.confirmationUrl !== 'string' || body.confirmationUrl === '') {
      throw new AuthError('server');
    }
    return body.confirmationUrl;
  }

  /**
   * Отправка партии аналитических событий (O-260817-05). Возвращает `false`
   * молча на любой сетевой отказ — очередь на диске остаётся нетронутой,
   * `AnalyticsQueue` попробует снова при следующем выходе в сеть.
   */
  async sendAnalyticsEvents(events: readonly unknown[]): Promise<boolean> {
    const token = await this.accessToken();
    if (token === null) return false;
    try {
      const response = await this.send(`${this.base}/analytics/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ events }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Замкнуть вход по тому, что принесла оболочка.
   *
   * `magicToken` обменивается здесь и только здесь: `device_id` знает
   * приложение, а не браузер, поэтому пройти по ссылке из письма «само»
   * не получится — и это защита, а не неудобство (ТЗ §5.5).
   */
  async adopt(callback: AuthCallback): Promise<CloudSession> {
    if (callback.error !== undefined) throw new AuthError(codeOf(callback.error));

    if (typeof callback.magicToken === 'string' && callback.magicToken.length > 0) {
      return this.exchangeMagicToken(callback.magicToken);
    }

    if (typeof callback.accessToken === 'string' && callback.accessToken.length > 0) {
      // Сервер уже обменял токен и вернул сессию во фрагменте. Кто именно
      // вошёл — спрашиваем у `/auth/me`: складывать почту в адрес незачем.
      const deviceId = await this.deviceId();
      const lifetime = (callback.expiresIn ?? 0) * 1000;
      const provisional: CloudSession = {
        accessToken: callback.accessToken,
        refreshToken: callback.refreshToken ?? '',
        expiresAt: this.now() + (lifetime > 0 ? lifetime : REFRESH_MARGIN_MS),
        userId: '',
        email: '',
        deviceId,
      };
      const identified = await this.identify(provisional);
      return this.persist(identified);
    }

    throw new AuthError('server');
  }

  /** Обмен одноразового токена из письма на сессию. */
  async exchangeMagicToken(token: string): Promise<CloudSession> {
    const deviceId = await this.deviceId();
    const query = new URLSearchParams({ token, device_id: deviceId, format: 'json' });
    const response = await this.send(`${this.base}/auth/magic-link/callback?${query.toString()}`, {
      headers: { 'x-device-id': deviceId },
    });
    if (response.status === 410 || response.status === 400) {
      throw new AuthError(codeOf(await errorCode(response)));
    }
    if (!response.ok) throw new AuthError('server');
    return this.persist(this.fromResponse(await json<SessionResponse>(response), deviceId));
  }

  // ── Жизнь сессии ───────────────────────────────────────────────────────────

  /**
   * Действующий access-токен. `null` — аккаунта нет либо сессия закончилась;
   * это нормальное состояние, локальная работа от него не зависит.
   */
  async accessToken(): Promise<string | null> {
    const session = this.session;
    if (session === null) return null;
    if (session.expiresAt - REFRESH_MARGIN_MS > this.now()) return session.accessToken;
    const refreshed = await this.refresh();
    return refreshed?.accessToken ?? null;
  }

  /** Принудительное обновление — после 401 от облака. */
  async refresh(): Promise<CloudSession | null> {
    if (this.refreshing !== null) return this.refreshing;
    const session = this.session;
    if (session === null || session.refreshToken === '') return null;

    this.refreshing = (async () => {
      try {
        const response = await this.send(`${this.base}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (!response.ok) {
          // Сессия отозвана или просрочена — забываем её молча. Заметки на
          // месте, синк просто становится локальным.
          if (response.status === 401 || response.status === 400) await this.clear();
          return null;
        }
        return await this.persist(
          this.fromResponse(await json<SessionResponse>(response), session.deviceId),
        );
      } catch {
        // Сети нет — старый токен ещё может пригодиться, сессию не трогаем.
        return null;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  /** Выход: сервер гасит refresh-токен, устройство забывает всё. */
  async signOut(): Promise<void> {
    const session = this.session;
    await this.clear();
    if (session === null || session.refreshToken === '') return;
    await this.send(`${this.base}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    this.session = null;
    await this.host.prefs.set<CloudSession | null>(AUTH_PREF.session, null);
  }

  // ── Внутреннее ─────────────────────────────────────────────────────────────

  /** База уже содержит `/api/v1` — это условие контракта `AppHost`. */
  private get base(): string {
    return this.host.cloudBaseUrl.replace(/\/+$/, '');
  }

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch {
      throw new AuthError('unreachable');
    }
  }

  private fromResponse(body: SessionResponse, fallbackDevice: string): CloudSession {
    return {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: this.now() + Math.max(body.expiresIn, 0) * 1000,
      userId: body.user?.id ?? '',
      email: body.user?.email ?? '',
      deviceId: body.device?.id ?? fallbackDevice,
      analyticsOptIn: body.user?.analyticsOptIn === true,
    };
  }

  /** Кто вошёл. Ошибка не фатальна: сессия рабочая и без почты в интерфейсе. */
  private async identify(session: CloudSession): Promise<CloudSession> {
    try {
      const response = await this.fetchImpl(`${this.base}/auth/me`, {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'x-device-id': session.deviceId,
        },
      });
      if (!response.ok) return session;
      const body = await json<{
        id?: string;
        email?: string;
        device?: { id?: string };
        marketingOptIn?: unknown;
        analyticsOptIn?: unknown;
      }>(response);
      return {
        ...session,
        userId: body.id ?? session.userId,
        email: body.email ?? session.email,
        deviceId: body.device?.id ?? session.deviceId,
        marketingOptIn: body.marketingOptIn === true,
        analyticsOptIn: body.analyticsOptIn === true,
      };
    } catch {
      return session;
    }
  }

  private async persist(session: CloudSession): Promise<CloudSession> {
    this.session = session;
    this.device = session.deviceId;
    await this.host.prefs.set(AUTH_PREF.session, session);
    return session;
  }
}

/** Код отказа сервера → код, который понимает контроллер. */
function codeOf(serverCode: string): AuthErrorCode {
  if (serverCode.startsWith('magic_link')) return 'link_dead';
  if (serverCode === 'session_expired') return 'link_dead';
  if (serverCode.startsWith('oauth') || serverCode.startsWith('yandex')) return 'declined';
  if (serverCode === 'too_many_attempts') return 'too_soon';
  if (serverCode === 'mail_failed') return 'mail_failed';
  return 'server';
}

async function errorCode(response: Response): Promise<string> {
  const body = await json<ServerErrorBody>(response).catch(() => ({}) as ServerErrorBody);
  return body.error?.code ?? 'server';
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function isSession(value: unknown): value is CloudSession {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CloudSession>;
  return typeof candidate.accessToken === 'string' && typeof candidate.deviceId === 'string';
}

/** Случайные байты платформенным генератором; `Math.random` — только запасной. */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const source = globalThis.crypto;
  if (source !== undefined && typeof source.getRandomValues === 'function') {
    source.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
