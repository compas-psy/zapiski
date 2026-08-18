import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * `POST /api/v1/analytics/events` (ТЗ §6, O-260817-05; устройство без
 * аккаунта — O-260817-15).
 *
 * Независимые замки проверяются по отдельности, потому что каждый защищает
 * от своего: флаг — от того, что фича вообще не готова; согласие — от того,
 * что конкретный владелец (аккаунт ИЛИ устройство) его не давал ИЛИ ОТОЗВАЛ;
 * `.strict()`-схема — от того, что в `props` протащат то, чего там быть не
 * должно (правило 2, charter/12_ANALYTICS.md §1).
 */
describe.skipIf(noDatabase())('POST /api/v1/analytics/events', () => {
  /* Каждый тест — свой deviceId: события копятся в общей базе на весь блок
     `beforeAll`, общий id между тестами загрязнял бы чужие assert'ы. */
  let deviceCounter = 0;
  function freshDeviceId(): string {
    deviceCounter += 1;
    return `dev-test-${deviceCounter.toString().padStart(8, '0')}`;
  }

  async function optIn(harness: Harness, userId: string): Promise<void> {
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [userId]);
  }

  async function optInDevice(harness: Harness, deviceId: string): Promise<void> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/analytics/device-consent',
      payload: { device_id: deviceId, opt_in: true },
    });
    expect(response.statusCode).toBe(200);
  }

  async function eventsFor(harness: Harness, userId: string): Promise<Record<string, unknown>[]> {
    const result = await harness.db.query(
      'SELECT event, props FROM analytics_events WHERE user_id = $1 ORDER BY id',
      [userId],
    );
    return result.rows as Record<string, unknown>[];
  }

  async function eventsForDevice(harness: Harness, deviceId: string): Promise<Record<string, unknown>[]> {
    const result = await harness.db.query(
      'SELECT event, props, user_id FROM analytics_events WHERE device_id = $1 ORDER BY id',
      [deviceId],
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

    it('токен есть, но недействителен — 401, не тихий переход на анонимный путь', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        headers: { authorization: 'Bearer garbage' },
        payload: { events: [{ event: 'sync_completed', ts: new Date().toISOString(), props: { pushed: 1, pulled: 0, conflicts: 0 } }] },
      });
      expect(response.statusCode).toBe(401);
    });

    it('пустой батч без токена — 400 раньше, чем дело доходит до владельца', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: { events: [] },
      });
      expect(response.statusCode).toBe(400);
    });

    /*
     * O-260817-15: аккаунт для метаданных не обязателен — вход в проде не
     * доведён, а ЗАПИСКИ работает локально. Без токена владелец — deviceId,
     * а не отказ.
     */
    it('без токена и без device_id — 400, владелец события не назван вовсе', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: {
          events: [{ event: 'sync_completed', ts: new Date().toISOString(), props: { pushed: 1, pulled: 0, conflicts: 0 } }],
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('без токена, с device_id, но без согласия устройства — 404, ничего не пишется', async () => {
      const deviceId = freshDeviceId();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: {
          device_id: deviceId,
          events: [{ event: 'sync_completed', ts: new Date().toISOString(), props: { pushed: 1, pulled: 0, conflicts: 0 } }],
        },
      });
      expect(response.statusCode).toBe(404);
      expect(await eventsForDevice(harness, deviceId)).toHaveLength(0);
    });

    it('без токена, с device_id и согласием устройства — 200, событие хранится без user_id', async () => {
      const deviceId = freshDeviceId();
      await optInDevice(harness, deviceId);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: {
          device_id: deviceId,
          events: [{ event: 'note_saved', ts: new Date().toISOString(), props: { length_bucket: 's', encrypted: false } }],
        },
      });

      expect(response.statusCode).toBe(200);
      const stored = await eventsForDevice(harness, deviceId);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.['event']).toBe('note_saved');
      expect(stored[0]?.['user_id']).toBeNull();
    });

    it('отзыв согласия устройства закрывает приёмник немедленно', async () => {
      const deviceId = freshDeviceId();
      await optInDevice(harness, deviceId);
      const revoke = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/device-consent',
        payload: { device_id: deviceId, opt_in: false },
      });
      expect(revoke.statusCode).toBe(200);

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: {
          device_id: deviceId,
          events: [{ event: 'note_saved', ts: new Date().toISOString(), props: { length_bucket: 's', encrypted: false } }],
        },
      });
      expect(response.statusCode).toBe(404);
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
        payload: { events: [{ event: 'note_saved', ts: new Date().toISOString(), props: { length_bucket: 's', encrypted: false } }] },
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
        payload: { events: [{ event: 'note_saved', ts: new Date().toISOString(), props: { length_bucket: 's', encrypted: false } }] },
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
        payload: { events: [{ event: 'note_saved', ts: new Date().toISOString(), props: { length_bucket: 's', encrypted: false } }] },
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
            { event: 'note_saved', ts, props: { length_bucket: 'm', encrypted: true } },
            { event: 'note_searched', ts, props: { query_length_bucket: 'xs', results_count: 3 } },
            { event: 'sync_completed', ts, props: { pushed: 2, pulled: 1, conflicts: 0 } },
            { event: 'export_requested', ts, props: { format: 'zip', notes_count: 12 } },
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

    it('device_id неверного формата — 400, а не молчаливо проигнорирован', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/events',
        payload: {
          device_id: 'короткий',
          events: [{ event: 'sync_completed', ts: new Date().toISOString(), props: { pushed: 1, pulled: 0, conflicts: 0 } }],
        },
      });
      expect(response.statusCode).toBe(400);
    });
  });
});

/**
 * `POST /api/v1/analytics/device-consent` (O-260817-15) — согласие устройства
 * без аккаунта. Без токена сознательно: до входа согласие не к чему
 * привязать, кроме устройства.
 */
describe.skipIf(noDatabase())('POST /api/v1/analytics/device-consent', () => {
  it('флаг выключен (значение по умолчанию) — 404', async () => {
    const harness = await createHarness();
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/device-consent',
        payload: { device_id: 'dev-test-consent0', opt_in: true },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('флаг включён: записывает согласие и возвращает то, что записано', async () => {
    const harness = await createHarness({ env: { ANALYTICS_ENABLED: '1' } });
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/device-consent',
        payload: { device_id: 'dev-test-consent1', opt_in: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ analyticsOptIn: true });
    } finally {
      await harness.close();
    }
  });

  it('device_id неверного формата — 400', async () => {
    const harness = await createHarness({ env: { ANALYTICS_ENABLED: '1' } });
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/analytics/device-consent',
        payload: { device_id: 'x', opt_in: true },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await harness.close();
    }
  });
});
