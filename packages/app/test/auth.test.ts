/**
 * Возврат после входа (блокер приёмки №2).
 *
 * Проверяется то, ради чего порт и появился:
 *  • адрес возврата разбирается одинаково во всех трёх оболочках — в вебе,
 *    в `zapiski://` и в App Link;
 *  • токен НЕ остаётся в адресной строке после разбора (и, значит, ни в
 *    истории браузера, ни в `Referer` следующего перехода);
 *  • обмен одноразового токена идёт с `device_id` — иначе сервер откажет;
 *  • сессия обновляется сама по истечении access-токена;
 *  • пути ядра переведены в пути сервера.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  parseAuthCallback,
  stripAuthParams,
  takeAuthFromAddressBar,
  type AddressBar,
} from '../src/lib/auth-callback.js';
import { createCloudBackend, originOf } from '../src/state/cloud.js';
import { AuthError, SessionStore } from '../src/state/session.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import type { AuthCallback } from '../src/contract.js';
import { createTestHost } from './host.js';

// ─────────────────────────────────────────────────────────────────────────────
// Разбор адреса
// ─────────────────────────────────────────────────────────────────────────────

describe('разбор возврата', () => {
  it('берёт сессию из фрагмента: так её отдаёт AUTH_SUCCESS_REDIRECT', () => {
    const callback = parseAuthCallback(
      'https://zapiski.cmpas.ru/auth/callback#access_token=aaa&refresh_token=bbb&expires_in=900',
    );
    expect(callback).toEqual({ accessToken: 'aaa', refreshToken: 'bbb', expiresIn: 900 });
  });

  it('берёт одноразовый токен из query: так выглядит ссылка из письма', () => {
    const callback = parseAuthCallback(
      'https://zapiski.cmpas.ru/api/v1/auth/magic-link/callback?token=ottt',
    );
    expect(callback).toEqual({ magicToken: 'ottt' });
  });

  it('понимает deep-link со своей схемой — Windows и Android', () => {
    const callback = parseAuthCallback('zapiski://auth/callback#access_token=aaa&expires_in=60');
    expect(callback?.accessToken).toBe('aaa');
    expect(callback?.expiresIn).toBe(60);
  });

  it('отдаёт код отказа, а не выдумывает текст', () => {
    expect(parseAuthCallback('zapiski://auth?error=magic_link_expired')).toEqual({
      error: 'magic_link_expired',
    });
  });

  it('обычный адрес возвратом не считает', () => {
    expect(parseAuthCallback('https://zapiski.cmpas.ru/')).toBeNull();
    expect(parseAuthCallback('https://zapiski.cmpas.ru/#/settings')).toBeNull();
    expect(parseAuthCallback('не адрес вовсе')).toBeNull();
  });

  it('пустое значение токена возвратом не считает', () => {
    expect(parseAuthCallback('https://zapiski.cmpas.ru/auth?token=')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Токен не остаётся в адресной строке
// ─────────────────────────────────────────────────────────────────────────────

/** Окно с адресной строкой и историей — ровно то, что читает разбор. */
function addressBar(href: string): AddressBar & { replaced: string[] } {
  const replaced: string[] = [];
  const bar = {
    location: { href },
    history: {
      state: { note: 'x' },
      replaceState(_state: unknown, _title: string, url: string) {
        replaced.push(url);
        bar.location.href = url;
      },
    },
    replaced,
  };
  return bar;
}

describe('токен не остаётся в адресной строке', () => {
  it('одноразовый токен из query стирается, путь возврата уходит в корень', () => {
    const bar = addressBar('https://zapiski.cmpas.ru/auth/callback?token=ottt');
    const callback = takeAuthFromAddressBar(bar);

    expect(callback).toEqual({ magicToken: 'ottt' });
    expect(bar.replaced).toHaveLength(1);
    expect(bar.location.href).toBe('https://zapiski.cmpas.ru/');
    expect(bar.location.href).not.toContain('ottt');
    expect(bar.location.href).not.toContain('token');
  });

  it('сессия из фрагмента стирается целиком, включая refresh-токен', () => {
    const bar = addressBar(
      'https://zapiski.cmpas.ru/auth/callback#access_token=aaa&refresh_token=bbb&expires_in=900',
    );
    takeAuthFromAddressBar(bar);

    expect(bar.location.href).toBe('https://zapiski.cmpas.ru/');
    expect(bar.location.href).not.toMatch(/aaa|bbb|access_token|refresh_token/);
  });

  it('чужие параметры и маршрут приложения не трогаются', () => {
    const bar = addressBar('https://zapiski.cmpas.ru/?utm=letter&token=ottt#/settings');
    takeAuthFromAddressBar(bar);

    expect(bar.location.href).toBe('https://zapiski.cmpas.ru/?utm=letter#/settings');
  });

  it('история переписывается, а не дополняется: в ней токена тоже нет', () => {
    const bar = addressBar('https://zapiski.cmpas.ru/auth?token=ottt');
    const spy = vi.spyOn(bar.history, 'replaceState');
    takeAuthFromAddressBar(bar);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[2])).not.toContain('ottt');
  });

  it('на обычном адресе история не трогается вовсе', () => {
    const bar = addressBar('https://zapiski.cmpas.ru/#/note/1');
    expect(takeAuthFromAddressBar(bar)).toBeNull();
    expect(bar.replaced).toEqual([]);
  });

  it('stripAuthParams не оставляет ни пустого «?», ни пустого «#»', () => {
    expect(stripAuthParams('https://zapiski.cmpas.ru/x?token=a')).toBe('https://zapiski.cmpas.ru/x');
    expect(stripAuthParams('https://zapiski.cmpas.ru/x#access_token=a')).toBe(
      'https://zapiski.cmpas.ru/x',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Обмен токена и жизнь сессии
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_BODY = {
  accessToken: 'access-1',
  expiresIn: 900,
  refreshToken: 'refresh-1',
  refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  user: { id: 'u1', email: 'marina@ya.ru', analyticsOptIn: false },
  device: { id: 'device-1' },
};

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('сессия облака', () => {
  it('обменивает одноразовый токен с device_id и format=json', async () => {
    const calls: string[] = [];
    const host = createTestHost();
    const session = new SessionStore(host, {
      fetch: async (url) => {
        calls.push(url);
        return jsonOk(SESSION_BODY);
      },
    });

    const result = await session.adopt({ magicToken: 'ottt' });

    expect(calls).toHaveLength(1);
    const requested = new URL(calls[0] as string);
    expect(requested.pathname).toBe('/api/v1/auth/magic-link/callback');
    expect(requested.searchParams.get('token')).toBe('ottt');
    expect(requested.searchParams.get('format')).toBe('json');
    expect(requested.searchParams.get('device_id')).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(result.email).toBe('marina@ya.ru');
    expect(await session.accessToken()).toBe('access-1');
  });

  it('мёртвая ссылка — код отказа, а не исключение неизвестной природы', async () => {
    const host = createTestHost();
    const session = new SessionStore(host, {
      fetch: async () => jsonOk({ error: { code: 'magic_link_used' } }, 410),
    });

    await expect(session.adopt({ magicToken: 'ottt' })).rejects.toBeInstanceOf(AuthError);
    await expect(session.adopt({ magicToken: 'ottt' })).rejects.toMatchObject({
      code: 'link_dead',
    });
  });

  it('письмо просят с deviceId и платформой — без них сервер не примет', async () => {
    const bodies: string[] = [];
    const host = createTestHost();
    const session = new SessionStore(host, {
      fetch: async (_url, init) => {
        bodies.push(String(init?.body ?? ''));
        return jsonOk({ sent: true }, 202);
      },
    });

    await session.requestMagicLink('marina@ya.ru');
    const sent = JSON.parse(bodies[0] as string) as Record<string, string>;
    expect(sent['email']).toBe('marina@ya.ru');
    expect(sent['deviceId']).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(sent['platform']).toBe('web');
  });

  it('устройство одно и то же от запроса письма до обмена', async () => {
    const host = createTestHost();
    const session = new SessionStore(host, { fetch: async () => jsonOk({ sent: true }, 202) });
    const first = await session.deviceId();
    const second = await new SessionStore(host, {
      fetch: async () => jsonOk({ sent: true }, 202),
    }).deviceId();
    expect(second).toBe(first);
  });

  it('истёкший access-токен обновляется сам, без участия человека', async () => {
    let now = 1_000_000;
    const paths: string[] = [];
    const host = createTestHost();
    const session = new SessionStore(host, {
      now: () => now,
      fetch: async (url) => {
        paths.push(new URL(url).pathname);
        if (url.endsWith('/auth/refresh')) {
          return jsonOk({ ...SESSION_BODY, accessToken: 'access-2', refreshToken: 'refresh-2' });
        }
        return jsonOk(SESSION_BODY);
      },
    });

    await session.adopt({ magicToken: 'ottt' });
    expect(await session.accessToken()).toBe('access-1');

    now += 900_000; // access-токен истёк
    expect(await session.accessToken()).toBe('access-2');
    expect(paths).toContain('/api/v1/auth/refresh');
  });

  it('выход гасит refresh-токен на сервере и стирает сессию на устройстве', async () => {
    const paths: string[] = [];
    const host = createTestHost();
    const session = new SessionStore(host, {
      fetch: async (url) => {
        paths.push(new URL(url).pathname);
        return jsonOk(SESSION_BODY);
      },
    });

    await session.adopt({ magicToken: 'ottt' });
    await session.signOut();

    expect(paths).toContain('/api/v1/auth/logout');
    expect(session.current()).toBeNull();
    expect(await host.prefs.get('auth.session', null)).toBeNull();
  });

  it('токена нет ни в одном ключе настроек, кроме самой сессии', async () => {
    const host = createTestHost();
    const session = new SessionStore(host, { fetch: async () => jsonOk(SESSION_BODY) });
    await session.adopt({ magicToken: 'ottt' });

    expect(await host.prefs.get('auth.session', null)).toMatchObject({ accessToken: 'access-1' });
    expect(await host.prefs.get('account', null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Пути облака: ядро ходит по ADR-0003, сервер отвечает по своим
// ─────────────────────────────────────────────────────────────────────────────

describe('клиент облака', () => {
  it('база с префиксом версии не удваивает /api/v1', () => {
    expect(originOf('https://zapiski.cmpas.ru/api/v1')).toBe('https://zapiski.cmpas.ru');
    expect(originOf('https://zapiski.cmpas.ru/api/v1/')).toBe('https://zapiski.cmpas.ru');
  });

  async function backendWith(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    const host = createTestHost();
    const session = new SessionStore(host, { fetch: async () => jsonOk(SESSION_BODY) });
    await session.adopt({ magicToken: 'ottt' });
    return createCloudBackend({
      cloudBaseUrl: host.cloudBaseUrl,
      session,
      fetch: handler,
    });
  }

  it('список берётся из манифеста сервера, а ETag приводится к одному виду', async () => {
    const seen: string[] = [];
    const backend = await backendWith(async (url) => {
      seen.push(new URL(url).pathname);
      return jsonOk({
        entries: [{ path: 'Идея.md', etag: '"abc"', mtime: 1, size: 2 }],
        quota: { usedBytes: 0, limitBytes: 1 },
      });
    });

    const entries = await backend.list();
    expect(seen).toEqual(['/api/v1/vault/manifest']);
    expect(entries).toEqual([{ path: 'Идея.md', etag: 'abc', mtime: 1, size: 2 }]);
  });

  it('путь блоба едет сегментами адреса, а не параметром', async () => {
    let requested = '';
    const backend = await backendWith(async (url) => {
      requested = url;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { etag: '"e1"' } });
    });

    const blob = await backend.get('Проекты/Идея.md');
    expect(new URL(requested).pathname).toBe(
      `/api/v1/vault/blob/${encodeURIComponent('Проекты')}/${encodeURIComponent('Идея.md')}`,
    );
    expect(new URL(requested).searchParams.get('path')).toBeNull();
    expect(blob?.etag).toBe('e1');
  });

  it('каждый запрос уходит с живым токеном и идентификатором устройства', async () => {
    let headers: Record<string, string> = {};
    const backend = await backendWith(async (_url, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return jsonOk({ entries: [] });
    });

    await backend.list();
    expect(headers['authorization']).toBe('Bearer access-1');
    expect(headers['x-device-id']).toBe('device-1');
    /* Заголовок ядра со старым токеном не должен уехать вторым экземпляром. */
    expect(headers['Authorization']).toBeUndefined();
  });

  it('401 приводит к обновлению и повтору, а не к выходу из аккаунта', async () => {
    const tokens: string[] = [];
    let unauthorizedOnce = true;

    /* Один подставной сервер и на вход, и на облако: обновление токена — это
       и есть та точка, где они встречаются. */
    const server = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes('/auth/refresh')) return jsonOk({ ...SESSION_BODY, accessToken: 'access-2' });
      if (url.includes('/auth/')) return jsonOk(SESSION_BODY);
      tokens.push(((init?.headers ?? {}) as Record<string, string>)['authorization'] ?? '');
      if (unauthorizedOnce) {
        unauthorizedOnce = false;
        return jsonOk({ error: { code: 'unauthorized' } }, 401);
      }
      return jsonOk({ entries: [] });
    };

    const host = createTestHost();
    const session = new SessionStore(host, { fetch: server });
    await session.adopt({ magicToken: 'ottt' });

    const backend = createCloudBackend({
      cloudBaseUrl: host.cloudBaseUrl,
      session,
      fetch: server,
    });

    await backend.list();
    expect(tokens).toEqual(['Bearer access-1', 'Bearer access-2']);
    expect(session.current()).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Вход замкнут: от возврата по ссылке до рабочего облака
// ─────────────────────────────────────────────────────────────────────────────

describe('вход замыкается', () => {
  /** Подставной сервер: вход отвечает сессией, облако — пустым манифестом. */
  function server(): (url: string, init?: RequestInit) => Promise<Response> {
    return async (url) => {
      if (url.includes('/auth/')) return jsonOk(SESSION_BODY);
      return jsonOk({ entries: [], quota: { usedBytes: 0, limitBytes: 1 } });
    };
  }

  async function bootedApp(callbacks: {
    initial?: AuthCallback | null;
    onCallback?: (handler: (callback: AuthCallback) => void) => () => void;
  } = {}) {
    vi.stubGlobal('fetch', server());
    const host = createTestHost({ prefs: { onboarded: true } });
    const wired = {
      ...host,
      takeInitialAuthCallback: async () => callbacks.initial ?? null,
      ...(callbacks.onCallback ? { onAuthCallback: callbacks.onCallback } : {}),
    };
    const app = new AppController(wired);
    await app.boot();
    return app;
  }

  it('оболочка отдала возврат — приложение вошло и подняло облако', async () => {
    const app = await bootedApp();
    app.beginSignIn({ name: 'list' });
    expect(app.getState().route).toEqual({ name: 'signin' });

    await app.completeSignIn({ magicToken: 'ottt' });

    expect(app.getState().account?.email).toBe('marina@ya.ru');
    expect(app.getState().backendId).toBe('zapiski');
    /* Возвращаемся к тому, ради чего входили, а не «куда-нибудь». */
    expect(app.getState().route).toEqual({ name: 'list' });
    expect(app.getState().authError).toBeNull();
    app.dispose();
  });

  it('возврат холодного старта забирается сам, без единого нажатия', async () => {
    const app = await bootedApp({ initial: { magicToken: 'ottt' } });
    /* boot() уже спросил оболочку — ждём, пока обмен доедет. */
    await vi.waitFor(() => expect(app.getState().account?.email).toBe('marina@ya.ru'));
    expect(app.getState().backendId).toBe('zapiski');
    app.dispose();
  });

  it('мёртвая ссылка не ломает локальную работу и говорит словами реестра', async () => {
    vi.stubGlobal('fetch', async () => jsonOk({ error: { code: 'magic_link_expired' } }, 410));
    const host = createTestHost({ prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();

    const ok = await app.completeSignIn({ magicToken: 'ottt' });

    expect(ok).toBe(false);
    expect(app.getState().authError).toBe(strings('ru').errors.magicLinkExpired);
    expect(app.getState().backendId).toBeNull();
    /* Заметки на месте, vault открыт: аккаунт нужен только для облака. */
    expect(app.getState().ready).toBe(true);
    app.dispose();
  });

  it('выход из аккаунта отключает облако и не трогает заметки', async () => {
    const app = await bootedApp();
    await app.completeSignIn({ magicToken: 'ottt' });
    expect(app.getState().backendId).toBe('zapiski');

    await app.signOutCloud();

    expect(app.getState().account).toBeNull();
    expect(app.getState().backendId).toBeNull();
    expect(app.getState().ready).toBe(true);
    app.dispose();
  });
});
