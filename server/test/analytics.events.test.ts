import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';
// Импорт напрямую из исходников пакета, а не из package.json-зависимости:
// сервер намеренно не зависит от @zapiski/core в рантайме (см. шапку
// analytics-schema.ts) — это только тестовый мост, который тянет НАСТОЯЩИЙ
// клиентский конструктор конверта, а не переписывает его вручную литералом.
import { buildAnalyticsEvent } from '../../packages/core/src/analytics/schema.ts';

/**
 * `POST /api/v1/analytics/events` (ТЗ §6, O-260817-05).
 *
 * Три независимых замка проверяются по отдельности, потому что каждый
 * защищает от своего: флаг — от того, что фича вообще не готова; согласие —
 * от того, что конкретный человек его не давал ИЛИ ОТОЗВАЛ; `.strict()`-схема
 * — от того, что в `props` протащат то, чего там быть не должно (правило 2,
 * charter/12_ANALYTICS.md §1).
 */
describe.skipIf(noDatabase())('POST /api/v1/analytics/events', () => {
  async function optIn(harness: Harness, userId: string): Promise<void> {
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [userId]);
  }

  async function eventsFor(harness: Harness, userId: string): Promise<Record<string, unknown>[]> {
    const result = await harness.db.query(
      'SELECT event, props FROM analytics_events WHERE user_id = $1 ORDER BY id',
      [userId],
    );
    return result.rows as Record<string, unknown>[];
  }

  describe('флаг выключен (значение по умолчанию)', () => {
    let harness: Harness;
    beforeAll(async () => {
      harness = await createHarness();
    });
    afterAll(async () => harness.close());

    it('404 даже с валидным телом и согласием', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [{ event: 'sync_completed', ts: new Date().toISOString(), props: { pushed: 1, pulled: 0, conflicts: 0 } }] },
      });

      expect(response.statusCode).toBe(404);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });
  });

  describe('флаг включён', () => {
    let harness: Harness;
    beforeAll(async () => {
      harness = await createHarness({ env: { ANALYTICS_ENABLED: '1' } });
    });
    afterAll(async () => harness.close());

    it('без токена — 401', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: { events: [] },
      });
      expect(response.statusCode).toBe(401);
    });

    it('без согласия — 404, ничего не пишется', async () => {
      const user = await createUser(harness);
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [{ event: 'sync_completed', ts: new Date().toISOString(), props: { pushed: 1, pulled: 0, conflicts: 0 } }] },
      });
      expect(response.statusCode).toBe(404);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });

    it('согласие, данное через POST /auth/analytics-consent, реально открывает приёмник', async () => {
      const user = await createUser(harness);
      const consent = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/analytics-consent',
        headers: user.authHeader,
        payload: { optIn: true },
      });
      expect(consent.statusCode).toBe(200);
      expect(consent.json()).toEqual({ analyticsOptIn: true });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [
            {
              event: 'note_saved',
              ts: new Date().toISOString(),
              props: { length_bucket: 's', encrypted: false },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(await eventsFor(harness, user.userId)).toHaveLength(1);
    });

    it('отозванное согласие закрывает приёмник немедленно, а не только на клиенте', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [
            {
              event: 'note_saved',
              ts: new Date().toISOString(),
              props: { length_bucket: 's', encrypted: false },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
          ],
        },
      });

      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/analytics-consent',
        headers: user.authHeader,
        payload: { optIn: false },
      });

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [
            {
              event: 'note_saved',
              ts: new Date().toISOString(),
              props: { length_bucket: 's', encrypted: false },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
          ],
        },
      });
      expect(response.statusCode).toBe(404);
      expect(await eventsFor(harness, user.userId)).toHaveLength(1); // только первое, до отзыва
    });

    it('принимает валидный батч всех четырёх событий и хранит их props как есть', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);
      const ts = new Date().toISOString();

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [
            {
              event: 'note_saved',
              ts,
              props: { length_bucket: 'm', encrypted: true },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
            {
              event: 'note_searched',
              ts,
              props: { query_length_bucket: 'xs', results_count: 3 },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
            {
              event: 'sync_completed',
              ts,
              props: { pushed: 2, pulled: 1, conflicts: 0 },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
            {
              event: 'export_requested',
              ts,
              props: { format: 'zip', notes_count: 12 },
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: 4 });
      const stored = await eventsFor(harness, user.userId);
      expect(stored.map((row) => row['event']).sort()).toEqual([
        'export_requested',
        'note_saved',
        'note_searched',
        'sync_completed',
      ]);
    });

    it('конверт, собранный настоящим клиентским buildAnalyticsEvent, а не литералом руками, — принят (Д-4)', async () => {
      // Ловит именно то, что ручной литерал в тестах выше поймать не может:
      // buildAnalyticsEvent (packages/core/src/analytics/schema.ts:58,90)
      // всегда кладёт в конверт поле schemaVersion — сервер обязан его знать,
      // а не молча валить 400 на каждое настоящее событие.
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const event = buildAnalyticsEvent('sync_completed', { pushed: 3, pulled: 1, conflicts: 0 });
      expect(event).not.toBeNull();
      expect(event).toHaveProperty('schemaVersion');

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [event] },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: 1 });
      const stored = await eventsFor(harness, user.userId);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.['event']).toBe('sync_completed');
    });

    it('повторная отправка той же пачки не увеличивает счётчики (C3, Д-6)', async () => {
      // Ретрай — штатный сценарий для офлайн-очереди ЗАПИСОК: сервер мог
      // записать батч и ответить, а ответ потерялся по дороге — клиент не
      // получил `ok`, `ack` не выполнен, и при следующем выходе в сеть та же
      // пачка уходит снова. Без ключа события это задваивает счётчики на
      // панели; здесь — сама пачка, отправленная дважды.
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const events = [
        buildAnalyticsEvent('sync_completed', { pushed: 1, pulled: 0, conflicts: 0 }),
        buildAnalyticsEvent('note_saved', { length_bucket: 's', encrypted: false }),
      ];

      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events },
      });
      expect(first.statusCode).toBe(200);
      expect(await eventsFor(harness, user.userId)).toHaveLength(2);

      // Та же самая пачка — те же eventId, потому что это тот же уже
      // построенный объект, не пересобранный заново (см. schema.ts: eventId
      // генерируется в buildAnalyticsEvent, не при отправке).
      const second = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events },
      });
      expect(second.statusCode).toBe(200);
      expect(await eventsFor(harness, user.userId)).toHaveLength(2); // не 4
    });

    it('два РАЗНЫХ события с чужим совпавшим eventId — не задваивание, а конфликт: второе теряется на приёме, а не тихо перезаписывает', async () => {
      // Не тест на «желаемое поведение подмены» — тест на факт: уникальный
      // индекс по event_id глобальный (не в паре с user_id), поэтому
      // ON CONFLICT DO NOTHING относится к событию целиком. Это документирует
      // границу применимости C3: id обязан быть по-настоящему случайным
      // (buildAnalyticsEvent так и делает, см. analytics-schema.test.ts).
      const user = await createUser(harness);
      await optIn(harness, user.userId);
      const shared = buildAnalyticsEvent('sync_completed', { pushed: 1, pulled: 0, conflicts: 0 })!;
      const different = {
        ...buildAnalyticsEvent('sync_completed', { pushed: 99, pulled: 0, conflicts: 0 })!,
        eventId: shared.eventId,
      };

      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [shared] },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [different] },
      });

      const stored = await eventsFor(harness, user.userId);
      expect(stored).toHaveLength(1);
      expect((stored[0]?.['props'] as { pushed: number }).pushed).toBe(1); // первый, не второй
    });

    it('неизвестное имя события — весь батч отклонён, ничего не сохранено', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [{ event: 'note_deleted_forever', ts: new Date().toISOString(), props: {} }] },
      });

      expect(response.statusCode).toBe(400);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });

    it('содержимое заметки, подсунутое лишним полем в props, — 400, ничего не сохранено (правило 2)', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);
      const noteContent = 'Клиент рассказал про развод, телефон +7 900 123-45-67';

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [
            {
              event: 'note_saved',
              ts: new Date().toISOString(),
              props: { length_bucket: 's', encrypted: false, note: noteContent },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.stringify(response.json())).not.toContain(noteContent);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });

    it('поле неверного типа (число вместо enum) — 400, ничего не сохранено', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [{ event: 'note_saved', ts: new Date().toISOString(), props: { length_bucket: 12345, encrypted: false } }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });

    it('пустой батч — 400, а не тихое 200', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    it('батч длиннее лимита — 400', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);
      const ts = new Date().toISOString();
      const events = Array.from({ length: 201 }, () => ({
        event: 'sync_completed',
        ts,
        props: { pushed: 0, pulled: 0, conflicts: 0 },
      }));

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: { events },
      });

      expect(response.statusCode).toBe(400);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });

    it('rebillId, пароль терминала и прочие платёжные реквизиты структурно невозможны — в реестре событий их нет вовсе', async () => {
      const user = await createUser(harness);
      await optIn(harness, user.userId);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: user.authHeader,
        payload: {
          events: [
            {
              event: 'sync_completed',
              ts: new Date().toISOString(),
              props: { pushed: 1, pulled: 0, conflicts: 0, rebillId: 'секрет', password: 'секрет' },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(await eventsFor(harness, user.userId)).toHaveLength(0);
    });
  });
});
