/**
 * Вход по почте целиком: настоящий клиент, настоящий сокет, настоящий сервер.
 *
 * ── Зачем ещё один набор, если magic-link уже покрыт ────────────────────────
 *
 * Покрыт наполовину. Соседний файл ходит через `app.inject`: он проверяет,
 * что сервер отвечает правильно на правильный запрос. Но запрос там составлен
 * тестом. А ломался вход ровно на стыке: приложение слало не то, что сервер
 * ожидал, и обе половины по отдельности были зелёными.
 *
 * Здесь запрос составляет `SessionStore` — тот самый класс, который работает
 * в оболочке Windows, — и уезжает в сеть через настоящий TCP. Ни одного байта
 * не пишет тест: он только смотрит и записывает.
 *
 * ── Что это доказывает ──────────────────────────────────────────────────────
 *
 * Что цепочка «платформа → тело запроса → письмо → переход по ссылке →
 * возврат в приложение» замкнута для Windows, и что ссылка из письма несёт
 * приложению всё нужное для сессии. Это ответ на требование заказчика
 * проверить контракт платформы фактом, а не рассуждением.
 *
 * Чего НЕ доказывает: что Windows выполнит переход по `zapiski://`. Это делает
 * система, и проверяется на машине.
 */
import { createServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, noDatabase, type Harness } from './helpers/app.ts';

/*
 * Клиент берётся исходником, а не копией: копия разъедется в первый же день.
 *
 * Загружается он в рантайме и по неразбираемому пути — намеренно. Обычный
 * `import` втянул бы `packages/core` в программу `tsc` сервера, а у сервера
 * нет и не должно быть DOM: `CryptoKey`, `BodyInit` и прочее там неизвестны,
 * и проверка типов посыпалась бы двумя десятками ошибок в чужом пакете.
 * Сервер не зависит от клиентского пакета — это правило важнее удобства
 * импорта.
 *
 * Проверка типов на клиентский API здесь и не нужна: её делает сам
 * `packages/app`. Нужно другое — чтобы в сеть ушли байты НАСТОЯЩЕГО клиента.
 * Если у него переименуют метод, тест упадёт на первом же обращении.
 */
interface MagicLinkClient {
  requestMagicLink(email: string, consents: { marketing: boolean }): Promise<void>;
}
type ClientCtor = new (host: unknown, options: { fetch: FetchLike }) => MagicLinkClient;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const CLIENT_SOURCE = '../../packages/app/src/state/session.ts';

async function loadClient(): Promise<ClientCtor> {
  const module = (await import(/* @vite-ignore */ CLIENT_SOURCE)) as { SessionStore: ClientCtor };
  return module.SessionStore;
}

const APP_RETURN = 'zapiski://auth/callback';

/** Свободный порт нужен ДО подъёма: адрес из письма обязан быть настоящим. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Расшифровка обмена — она же лог для отчёта. */
const journal: string[] = [];
function note(line: string): void {
  journal.push(line);
}

describe.skipIf(noDatabase())('вход по почте: клиент, сокет, сервер', () => {
  let harness: Harness;
  let base: string;
  let SessionStore: ClientCtor;

  /*
   * Адрес и устройство запоминаются, потому что по ним и спрашивается база.
   *
   * Postgres в прогоне ОДИН на все наборы (см. `test/globalSetup.ts`), и файлы
   * идут параллельно. Первая редакция читала «последнюю строку в magic_tokens»
   * — и в одиночку была зелёной, а в общем прогоне ловила чужой токен из
   * соседнего набора. Уронил preflight, и поделом: набор, зелёный только в
   * одиночестве, не стережёт ничего.
   */
  const windowsEmail = `e2e.win.${process.pid}@example.test`;
  /* Nonce, который клиент сгенерировал и отправил при запросе ссылки (SEC:
     auth nonce) — сверяется с тем, что сервер эхом вернёт в deep-link. */
  let windowsNonce: string | null = null;

  beforeAll(async () => {
    SessionStore = await loadClient();
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    harness = await createHarness({
      env: {
        PUBLIC_BASE_URL: base,
        AUTH_SUCCESS_REDIRECT: `${base}/auth/callback`,
        AUTH_SUCCESS_REDIRECT_APP: APP_RETURN,
      },
    });
    await harness.app.listen({ port, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await harness.close();
    if (process.env['ZAPISKI_E2E_LOG'] === '1') {
      console.log(`\n${journal.join('\n')}\n`);
    }
  });

  /**
   * `AppHost` в объёме, который нужен `SessionStore`: адрес облака и место под
   * device_id. Остального у него не спрашивают.
   */
  function hostWith(kind: 'windows' | 'macos' | 'web'): unknown {
    const map = new Map<string, unknown>();
    return {
      cloudBaseUrl: `${base}/api/v1`,
      platform: { kind },
      prefs: {
        get: async (key: string, fallback: unknown) => (map.has(key) ? map.get(key) : fallback),
        set: async (key: string, value: unknown) => void map.set(key, value),
        remove: async (key: string) => void map.delete(key),
      },
    };
  }

  /** Настоящий fetch с записью в журнал: ни одного поля не подменяет. */
  const watchedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    note(`→ ${init?.method ?? 'GET'} ${url}`);
    if (typeof init?.body === 'string') note(`  тело: ${init.body}`);
    const response = await globalThis.fetch(url, init);
    note(`← ${response.status} ${response.headers.get('content-type') ?? ''}`.trimEnd());
    return response;
  };

  it('Windows: запрос уходит с platform=windows и сервер принимает его', async () => {
    harness.mailer.reset();
    const store = new SessionStore(hostWith('windows'), { fetch: watchedFetch });

    note('── Windows ─────────────────────────────────────────────');
    await expect(store.requestMagicLink(windowsEmail, { marketing: false })).resolves.toBeUndefined();

    /*
     * Платформа записана сервером к ВЫДАННОМУ ТОКЕНУ, а не к устройству:
     * устройство заводится позже, при обмене. Читаем базу, а не ответ —
     * ответ 202 пустой и подтвердить ничего не мог.
     *
     * Это и есть та величина, по которой сервер потом выберет адрес возврата.
     * Если бы клиент прислал незнакомую строку, zod отверг бы запрос целиком,
     * и письмо не ушло бы вовсе.
     */
    const token = await harness.db.query<{ platform: string | null; nonce: string | null }>(
      `SELECT platform, nonce FROM magic_tokens WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1`,
      [windowsEmail],
    );
    note(`  сервер записал токену platform=${token.rows[0]?.platform ?? '—'}`);
    expect(token.rows[0]?.platform).toBe('windows');
    /* Клиент (настоящий SessionStore) сам сгенерировал nonce и отправил его
       вместе с запросом — сервер обязан был его сохранить как есть. */
    windowsNonce = token.rows[0]?.nonce ?? null;
    note(`  сервер записал токену nonce=${windowsNonce ?? '—'}`);
    expect(windowsNonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('ссылка из письма ведёт в наш же API и несёт device_id', async () => {
    const sent = harness.mailer.last();
    expect(sent).toBeDefined();
    const url = new URL(sent!.url);
    note(`  ссылка в письме: ${url.origin}${url.pathname}?token=…&device_id=${url.searchParams.get('device_id')}`);

    expect(url.origin).toBe(base);
    expect(url.pathname).toBe('/api/v1/auth/magic-link/callback');
    /* Без device_id ссылка не обменяется: токен привязан к устройству. */
    expect(url.searchParams.get('device_id')).toMatch(/^dev-[0-9a-f]{32}$/);
    expect(url.searchParams.get('token')).toBeTruthy();
  });

  it('переход из письма замыкает вход и уводит в приложение, а не на сайт', async () => {
    const sent = harness.mailer.last();
    const url = new URL(sent!.url);

    /* Так по ссылке идёт БРАУЗЕР: без заголовков приложения, без редиректов
       за нас — иначе не увидеть, что именно сервер ответил. */
    note(`→ GET ${url.pathname} (как из почтового клиента)`);
    const opened = await globalThis.fetch(url, { redirect: 'manual' });
    const body = await opened.text();
    note(`← ${opened.status} ${opened.headers.get('content-type') ?? ''}`);
    note(`  cache-control: ${opened.headers.get('cache-control') ?? '—'}`);

    expect(opened.status).toBe(200);
    expect(opened.headers.get('content-type')).toContain('text/html');
    expect(opened.headers.get('cache-control')).toContain('no-store');

    /* Переход выполняет страница, а не 302: на `zapiski://` браузер отвечает
       302 не всегда и молчит, когда не ответил.

       Адрес из разметки читается С РАСКОДИРОВКОЙ сущностей: в HTML амперсанд
       записан как `&amp;`, и разбор «как есть» склеил бы имя следующего поля
       с хвостом сущности. Ровно на это первая редакция теста и попалась. */
    const target = (/url=([^"']+)/.exec(body)?.[1] ?? '')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'");
    note(`  страница уводит на: ${target.split('#')[0]}#…`);
    expect(target.startsWith(`${APP_RETURN}#`)).toBe(true);

    /* В приложение уезжает всё, из чего складывается сессия, — иначе оболочка
       примет ссылку и останется незалогиненной. */
    const payload = new URLSearchParams(target.slice(target.indexOf('#') + 1));
    for (const field of ['access_token', 'refresh_token', 'expires_in']) {
      expect(payload.get(field), `в ссылке для приложения нет ${field}`).toBeTruthy();
    }
    note(`  во фрагменте: ${[...payload.keys()].join(', ')}`);
    /* SEC: auth nonce — сервер обязан вернуть ТО ЖЕ значение, что клиент
       отправил при запросе письма (первый тест этого набора). Без этого
       эха `SessionStore.adopt` на другом конце отклонил бы этот самый,
       настоящий колбэк как чужой. */
    expect(payload.get('nonce')).toBe(windowsNonce);
    /* Именно refresh_token отличает «вошёл» от «вошёл на четверть часа»: без
       него оболочка потеряет сессию по истечении access-токена и попросит
       войти заново — жалоба, неотличимая от «вход не работает». */
    expect(payload.get('refresh_token')).not.toBe(payload.get('access_token'));

    /* Устройство заведено — теперь и у него записана платформа. */
    const device = await harness.db.query<{ platform: string | null }>(
      `SELECT d.platform
         FROM devices d
         JOIN users u ON u.id = d.user_id
        WHERE lower(u.email) = lower($1)
        ORDER BY d.created_at DESC
        LIMIT 1`,
      [windowsEmail],
    );
    note(`  сервер завёл устройство с platform=${device.rows[0]?.platform ?? '—'}`);
    expect(device.rows[0]?.platform).toBe('windows');
    /* Токены во фрагменте, а не в query: фрагмент не уходит на сервер и не
       оседает в логах прокси. */
    expect(target.slice(0, target.indexOf('#'))).not.toContain('access_token');
  });

  it('веб с того же сервера остаётся в браузере: развилка по платформе жива', async () => {
    harness.mailer.reset();
    note('── веб (для сравнения) ─────────────────────────────────');
    const store = new SessionStore(hostWith('web'), { fetch: watchedFetch });
    await store.requestMagicLink(`e2e.web.${process.pid}@example.test`, { marketing: false });

    const url = new URL(harness.mailer.last()!.url);
    const opened = await globalThis.fetch(url, { redirect: 'manual' });
    note(`← ${opened.status} location=${(opened.headers.get('location') ?? '').split('#')[0]}#…`);

    expect(opened.status).toBe(302);
    expect(opened.headers.get('location')?.startsWith(`${base}/auth/callback#`)).toBe(true);
  });
});
