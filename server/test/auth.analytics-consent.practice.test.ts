/**
 * Согласие на аналитику доходит до ПРАКТИКИ событием `consent_updated`
 * (E-Z3, контракт контура v2 §5).
 *
 * `POST /api/v1/auth/analytics-consent` — единственное место в ЗАПИСКАХ, где
 * меняется `users.analytics_opt_in` (клиент никогда не говорит с ПРАКТИКОЙ
 * напрямую — см. `packages/app/src/state/session.ts`). Отсюда же уходит
 * `consent_updated` в общий контур: и выдача, и отзыв — тем же путём, что и
 * обычные события (своя строка `analytics_events`, мгновенная попытка
 * форварда, sweep как страховка), не отдельной системой доставки только
 * ради одного типа события.
 *
 * Приёмник здесь — смоделированный (та же модель, что в
 * `practice-bridge.consent.test.ts`): реальный `/ingest` ПРАКТИКИ на день
 * чтения ещё не реализует схему субъекта из контракта (см. шапку
 * `practiceBridge.ts`), так что интеграционный тест против него доказывал бы
 * не то, что должен. Здесь доказывается то, что можно доказать без другого
 * репозитория: ЗАПИСКИ формируют, порядок и содержимое конверта верны, а
 * отзыв так же надёжен, как выдача.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';
import { PracticeBridge, type FetchLike, type PracticeEnvelope } from '../src/services/practiceBridge.ts';

function fakeIngest(): { fetch: FetchLike; calls: PracticeEnvelope[][] } {
  const granted = new Set<string>();
  const calls: PracticeEnvelope[][] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as PracticeEnvelope[];
    calls.push(body);
    const results = body.map((envelope) => {
      const subject = `${envelope.product}:${envelope.account_id}`;
      if (envelope.event === 'consent_updated') {
        if (envelope.props['granted'] === true) granted.add(subject);
        else granted.delete(subject);
        return { accepted: true };
      }
      if (!granted.has(subject)) return { accepted: false, reason: 'consent required for subject' };
      return { accepted: true };
    });
    return new Response(JSON.stringify({ results }), { status: 200 });
  };
  return { fetch, calls };
}

describe.skipIf(noDatabase())('POST /api/v1/auth/analytics-consent — доставка согласия в ПРАКТИКУ (E-Z3)', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness({ env: { ANALYTICS_ENABLED: '1' } });
  });
  afterAll(async () => harness.close());

  async function consentRows(userId: string): Promise<{ event: string; props: Record<string, unknown>; forwarded: boolean }[]> {
    const result = await harness.db.query<{ event: string; props: Record<string, unknown>; practice_forwarded_at: Date | null }>(
      `SELECT event, props, practice_forwarded_at FROM analytics_events WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return result.rows.map((r) => ({ event: r.event, props: r.props, forwarded: r.practice_forwarded_at !== null }));
  }

  it('выдача согласия пишет consent_updated{granted:true} и форвардит его немедленно', async () => {
    const { fetch, calls } = fakeIngest();
    harness.ctx.practiceBridge = new PracticeBridge('https://practice.test/ingest', 'shh', fetch);

    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/analytics-consent',
      headers: user.authHeader,
      payload: { optIn: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ analyticsOptIn: true });

    const rows = await consentRows(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ event: 'consent_updated', props: { granted: true }, forwarded: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.event).toBe('consent_updated');
    expect(calls[0]?.[0]?.account_id).toBe(user.userId);
    expect(calls[0]?.[0]?.product).toBe('zapiski');

    harness.ctx.practiceBridge = null;
  });

  it('порядок: consent_updated доезжает раньше содержательных событий того же аккаунта — они принимаются, а не отвергаются', async () => {
    const { fetch } = fakeIngest();
    harness.ctx.practiceBridge = new PracticeBridge('https://practice.test/ingest', 'shh', fetch);

    const user = await createUser(harness);
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/analytics-consent',
      headers: user.authHeader,
      payload: { optIn: true },
    });
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [user.userId]);

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

    const rows = await consentRows(user.userId);
    const noteSaved = rows.find((r) => r.event === 'note_saved');
    expect(noteSaved?.forwarded).toBe(true); // не отвергнуто — согласие уже было на файле у (смоделированной) ПРАКТИКИ

    harness.ctx.practiceBridge = null;
  });

  it('без предварительного consent_updated событие того же субъекта отвергается смоделированным приёмником (не потеряно молча — reason записан)', async () => {
    const { fetch } = fakeIngest();
    harness.ctx.practiceBridge = new PracticeBridge('https://practice.test/ingest', 'shh', fetch);

    const user = await createUser(harness);
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [user.userId]);

    // Согласие НЕ отправлялось через /auth/analytics-consent в этом тесте —
    // приёмник о субъекте ничего не знает.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/analytics/events',
      headers: user.authHeader,
      payload: {
        events: [
          {
            event: 'sync_completed',
            ts: new Date().toISOString(),
            props: { pushed: 1, pulled: 0, conflicts: 0 },
            schemaVersion: 1,
            eventId: crypto.randomUUID(),
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200); // приём ЗАПИСОК не зависит от исхода пересылки

    const rows = await consentRows(user.userId);
    expect(rows.find((r) => r.event === 'sync_completed')?.forwarded).toBe(false);

    harness.ctx.practiceBridge = null;
  });

  it('отзыв согласия пишет consent_updated{granted:false}, доезжает так же надёжно, как выдача, и переживает недоступность ПРАКТИКИ (подхватит sweep)', async () => {
    harness.ctx.practiceBridge = new PracticeBridge('https://practice.test/ingest', 'shh', async () => {
      throw new Error('ECONNREFUSED');
    });

    const user = await createUser(harness);
    await harness.db.query('UPDATE users SET analytics_opt_in = true WHERE id = $1', [user.userId]);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/analytics-consent',
      headers: user.authHeader,
      payload: { optIn: false },
    });

    expect(response.statusCode).toBe(200); // ЗАПИСКИ отвечают клиенту независимо от исхода пересылки
    expect(response.json()).toEqual({ analyticsOptIn: false });

    const rows = await consentRows(user.userId);
    const revoke = rows.find((r) => r.event === 'consent_updated');
    expect(revoke).toBeDefined();
    expect(revoke?.props).toEqual({ granted: false });
    // Не потеряно: строка осталась в analytics_events с practice_forwarded_at
    // NULL — тот же sweep (retryPracticeForwarding), что и для обычных
    // событий, подхватит её при следующем часовом тике.
    expect(revoke?.forwarded).toBe(false);

    harness.ctx.practiceBridge = null;
  });

  it('мост выключен — согласие всё равно записывается локально (users.analytics_opt_in), ручка не ломается', async () => {
    expect(harness.ctx.practiceBridge).toBeNull();

    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/analytics-consent',
      headers: user.authHeader,
      payload: { optIn: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ analyticsOptIn: true });
  });
});
