/**
 * Живой путь целиком: очередь клиента → `/api/v1/analytics/events` → мост →
 * `practice_forwarded_at`.
 *
 * ── Зачем отдельно от analytics.events.test.ts ───────────────────────────────
 *
 * Тот тест кладёт конверт в маршрут напрямую — пусть и настоящим клиентским
 * `buildAnalyticsEvent`. Здесь проверяется ШОВ, которого не касался ни один
 * прогон: тело, которое НАСТОЯЩИЙ клиент кладёт на провод
 * (`SessionStore.sendAnalyticsEvents` — свой JSON, свой заголовок, свой
 * `{events: […]}`), против настоящего `.strict()`-валидатора сервера, через
 * настоящий сокет.
 *
 * Заглушки чужой стороны нет ни с одного конца: клиент — исходник из
 * `packages/app`, сервер — настоящее приложение, база — настоящий Postgres.
 * Единственное, что изображается, — приёмник ПРАКТИКИ, потому что его код
 * лежит в чужом репозитории. Он отвечает ровно по документированному
 * контракту: HTTP 200 и `{results:[{accepted:true}]}` — то есть успех, который
 * надо ЗАСЛУЖИТЬ явным `accepted`, а не получить за один лишь код ответа.
 * И он же записывает, что именно к нему пришло: конверт сверяется, а не
 * принимается на веру.
 *
 * ── Чего этот тест НЕ доказывает ─────────────────────────────────────────────
 *
 * Первого звена — «человек сохранил заметку, и это превратилось в событие»
 * (`AppController.track`). Оно живёт в `packages/app/test/analytics.test.ts`,
 * где есть хранилище и экран; тащить их в серверный пакет незачем.
 * И, разумеется, это не прод: продовое доказательство — строка
 * «переслано 1, отвергнуто 0, ждёт 0» в шаге выкладки.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness, type TestUser } from './helpers/app.ts';

// Клиент — исходником и по неразбираемому пути: обычный import втянул бы
// packages/core в программу tsc сервера, где нет DOM. Тот же приём, что в
// auth.magic-link.e2e.test.ts, и по той же причине.
const CLIENT_SESSION = '../../packages/app/src/state/session.ts';
const CLIENT_QUEUE = '../../packages/core/src/analytics/queue.ts';
const CLIENT_SCHEMA = '../../packages/core/src/analytics/schema.ts';
const CLIENT_STORAGE = '../../packages/core/src/memory-storage.ts';

interface ReceivedBatch {
  authorization: string | undefined;
  body: unknown;
}

describe.skipIf(noDatabase())('живой путь: очередь клиента → приём → мост', () => {
  let harness: Harness;
  let user: TestUser;
  let receiver: Server;
  const received: ReceivedBatch[] = [];

  /** Тела, ушедшие клиентом на сервер: их же потом и разглядываем. */
  const sentBodies: string[] = [];

  let SessionStore: new (host: unknown, deps: unknown) => {
    load: () => Promise<unknown>;
    sendAnalyticsEvents: (events: readonly unknown[]) => Promise<boolean>;
    setAnalyticsConsent: (optIn: boolean) => Promise<boolean>;
  };
  let AnalyticsQueue: new (storage: unknown) => {
    enqueue: (event: unknown) => Promise<void>;
    take: (limit: number) => { id: string; event: unknown }[];
    ack: (ids: readonly string[]) => Promise<void>;
    size: number;
  };
  let buildAnalyticsEvent: (name: string, props: unknown, now?: () => number) => unknown;
  let MemoryVaultStorage: new () => unknown;

  let base = '';

  beforeAll(async () => {
    // Приёмник ПРАКТИКИ: контракт соблюдён дословно, и он же — свидетель.
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = raw;
        try {
          body = JSON.parse(raw);
        } catch {
          /* оставляем строкой — тест это увидит */
        }
        received.push({ authorization: request.headers.authorization, body });
        const count = Array.isArray(body) ? body.length : 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ results: Array.from({ length: count }, () => ({ accepted: true })) }));
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as AddressInfo).port;

    harness = await createHarness({
      env: {
        ANALYTICS_ENABLED: 'true',
        PRACTICE_INGEST_URL: `http://127.0.0.1:${receiverPort}/api/ingest`,
        PRACTICE_INGEST_SECRET: 'probe-secret-for-this-run-only',
      },
    });
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const appPort = (harness.app.server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${appPort}`;

    user = await createUser(harness);

    const session = (await import(/* @vite-ignore */ CLIENT_SESSION)) as {
      SessionStore: typeof SessionStore;
    };
    SessionStore = session.SessionStore;
    const queue = (await import(/* @vite-ignore */ CLIENT_QUEUE)) as {
      AnalyticsQueue: typeof AnalyticsQueue;
    };
    AnalyticsQueue = queue.AnalyticsQueue;
    const schema = (await import(/* @vite-ignore */ CLIENT_SCHEMA)) as {
      buildAnalyticsEvent: typeof buildAnalyticsEvent;
    };
    buildAnalyticsEvent = schema.buildAnalyticsEvent;
    const storage = (await import(/* @vite-ignore */ CLIENT_STORAGE)) as {
      MemoryVaultStorage: typeof MemoryVaultStorage;
    };
    MemoryVaultStorage = storage.MemoryVaultStorage;
  });

  afterAll(async () => {
    await harness?.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });

  /** Настоящий клиент с уже выданной сессией — вход проверяется другим тестом. */
  function client(): InstanceType<typeof SessionStore> {
    const prefs = new Map<string, unknown>([
      [
        'auth.session',
        {
          accessToken: user.accessToken,
          refreshToken: user.refreshToken,
          expiresAt: Date.now() + 10 * 60_000,
          userId: user.userId,
          email: user.email,
          deviceId: user.deviceId,
          analyticsOptIn: true,
        },
      ],
    ]);
    const host = {
      cloudBaseUrl: `${base}/api/v1`,
      platform: { kind: 'web' },
      prefs: {
        get: async (key: string, fallback: unknown) => (prefs.has(key) ? prefs.get(key) : fallback),
        set: async (key: string, value: unknown) => void prefs.set(key, value),
        remove: async (key: string) => void prefs.delete(key),
      },
    };
    const watched = async (url: string, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === 'string' && url.includes('/analytics/events')) sentBodies.push(init.body);
      return globalThis.fetch(url, init);
    };
    return new SessionStore(host, { fetch: watched });
  }

  async function optIn(): Promise<void> {
    /*
     * Согласие ставится НАСТОЯЩИМ клиентским методом, а не UPDATE в базе и не
     * своим fetch'ем: замок №2 обязан быть пройден тем же путём, каким его
     * проходит человек, нажимая тумблер в настройках.
     *
     * Это не педантизм. Первая версия этого теста звала эндпоинт руками и
     * слала `{analyticsOptIn: true}` — сервер ждёт `{optIn}`, ответил 400, и
     * дальше всё падало на `analytics_disabled`. Своя копия чужого запроса
     * разошлась с оригиналом на первом же поле; настоящий метод разойтись не
     * может по определению.
     *
     * Возвращаемое значение — то, что ЗАПИСАЛ сервер, а не то, что попросили.
     */
    const store = client();
    await store.load();
    await expect(store.setAnalyticsConsent(true)).resolves.toBe(true);
  }

  it('без согласия сервер не принимает — замок проверяется первым', async () => {
    const store = client();
    await store.load();
    const event = buildAnalyticsEvent('note_saved', { length_bucket: 's', encrypted: false });
    expect(event).not.toBeNull();

    // Согласия ещё нет: createUser его не ставит.
    await expect(store.sendAnalyticsEvents([event])).resolves.toBe(false);

    const rows = await harness.db.query('SELECT id FROM analytics_events WHERE user_id = $1', [user.userId]);
    expect(rows.rows).toHaveLength(0);
  });

  it('с согласия: событие доезжает до базы и до приёмника, очередь пустеет', async () => {
    await optIn();

    const storage = new MemoryVaultStorage();
    const queue = new AnalyticsQueue(storage);
    const event = buildAnalyticsEvent('note_saved', { length_bucket: 'm', encrypted: false });
    await queue.enqueue(event);
    expect(queue.size).toBe(1);

    const batch = queue.take(200);
    const store = client();
    await store.load();

    const ok = await store.sendAnalyticsEvents(batch.map((queued) => queued.event));
    expect(ok).toBe(true);

    // Очередь чистится по id, как в бою: ack, а не «убрать столько же».
    await queue.ack(batch.map((queued) => queued.id));
    expect(queue.size).toBe(0);

    const rows = await harness.db.query<{ event: string; practice_forwarded_at: Date | null; practice_reject_reason: string | null }>(
      'SELECT event, practice_forwarded_at, practice_reject_reason FROM analytics_events WHERE user_id = $1 ORDER BY id',
      [user.userId],
    );
    /*
     * Строк две, и это правильно: включение тумблера само по себе — событие
     * `consent_updated`, его пишет маршрут согласия. Нас интересует вторая.
     */
    expect(rows.rows.map((row) => row.event)).toEqual(['consent_updated', 'note_saved']);

    const saved = rows.rows[1];
    // Пересылка идёт строчным путём, прямо на приёме — sweep тут не нужен.
    expect(saved?.practice_forwarded_at).not.toBeNull();
    expect(saved?.practice_reject_reason).toBeNull();
  });

  /** Конверты, доехавшие до приёмника, — плоским списком. */
  function envelopes(): Record<string, unknown>[] {
    return received.flatMap((batch) =>
      Array.isArray(batch.body) ? (batch.body as Record<string, unknown>[]) : [],
    );
  }

  it('до приёмника доехал тот самый конверт, а не что-то похожее', () => {
    /*
     * Конвертов два: включение тумблера пересылается тем же строчным путём,
     * что и всё остальное — `consent_updated` уходит в ПРАКТИКУ сразу, а не
     * ждёт уборки. Это не побочный эффект теста, а поведение маршрута
     * согласия, и оно правильное: у приёмника согласие субъекта должно
     * появиться НЕ ПОЗЖЕ первого события этого субъекта.
     */
    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const batch of received) {
      expect(batch.authorization).toBe('Bearer probe-secret-for-this-run-only');
      expect(Array.isArray(batch.body)).toBe(true);
    }

    const envelope = envelopes().find((item) => item['event'] === 'note_saved');
    expect(envelope).toBeDefined();

    expect(envelope?.['product']).toBe('zapiski');
    expect(envelope?.['event']).toBe('note_saved');
    expect(envelope?.['account_id']).toBe(user.userId);
    expect(typeof envelope?.['event_id']).toBe('string');
    expect(typeof envelope?.['ts']).toBe('string');
    // ts — строка ISO-8601, а не число и не Date.
    expect(new Date(String(envelope?.['ts'])).toString()).not.toBe('Invalid Date');
  });

  it('тело, ушедшее клиентом, — это {events:[…]}, и в нём нет ничего лишнего', () => {
    expect(sentBodies.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(sentBodies[sentBodies.length - 1] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(last)).toEqual(['events']);

    const events = last['events'] as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    // Ровно те поля, что описаны контрактом: лишнее уронило бы батч целиком
    // на .strict()-схеме — и это уже случилось бы выше, в предыдущем тесте.
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['event', 'eventId', 'props', 'schemaVersion', 'ts']);
  });

  it('повтор того же батча не задваивает строку: event_id держит идемпотентность', async () => {
    const seenBefore = envelopes().length;
    const before = await harness.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM analytics_events WHERE user_id = $1',
      [user.userId],
    );

    const store = client();
    await store.load();
    const repeated = JSON.parse(sentBodies[sentBodies.length - 1] ?? '{}') as { events: unknown[] };
    await expect(store.sendAnalyticsEvents(repeated.events)).resolves.toBe(true);

    const after = await harness.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM analytics_events WHERE user_id = $1',
      [user.userId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(envelopes().length).toBe(seenBefore);

    // И повторно в ПРАКТИКУ он тоже не уехал: пересылается только ВСТАВЛЕННОЕ
    // (`RETURNING id` пуст на конфликте), поэтому число конвертов не выросло.
    expect(envelopes().filter((item) => item['event'] === 'note_saved')).toHaveLength(1);
  });

  it('у этого человека не осталось непереслáнного', async () => {
    /*
     * Спрашиваем ТОЛЬКО про своего пользователя, и вот почему.
     *
     * База в прогоне ОДНА на все файлы (test/globalSetup.ts: «тесты
     * изолируются друг от друга собственными пользователями, а не
     * собственными базами»). Первая версия этой проверки звала
     * `retryPracticeForwarding(harness.ctx)` и требовала `attempted === 0` —
     * локально проходило, в CI дало 13: уборка глобальная, она подобрала
     * чужие строки из соседних файлов.
     *
     * Это тот же капкан общей базы, на котором уже спотыкался
     * auth.magic-link.e2e.test.ts, и лечится он так же — областью запроса, а
     * не «запустим уборку и посмотрим». Заодно исчезает и обратный вред:
     * глобальная уборка из теста утащила бы чужие события в ЭТОТ приёмник.
     */
    const pending = await harness.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM analytics_events
        WHERE user_id = $1
          AND practice_forwarded_at IS NULL
          AND practice_reject_reason IS NULL`,
      [user.userId],
    );
    expect(pending.rows[0]?.count).toBe('0');
  });
});
