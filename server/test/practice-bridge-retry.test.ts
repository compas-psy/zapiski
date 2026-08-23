/**
 * Sweep-повтор пересылки в ПРАКТИКУ (C4): `retryPracticeForwarding` подбирает
 * `analytics_events`, не дошедшие до `/ingest` с первой попытки
 * (`practice_forwarded_at IS NULL`) — маршрут проверяется отдельно
 * (`analytics.events.test.ts`), здесь — только сам механизм повтора.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';
import { PracticeBridge, retryPracticeForwarding, type PracticeEnvelope } from '../src/services/practiceBridge.ts';

describe.skipIf(noDatabase())('retryPracticeForwarding', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await createHarness();
  });
  afterAll(async () => harness.close());

  /** Строка в analytics_events, как будто вставленная маршрутом приёма — напрямую в БД, без HTTP. */
  async function insertUnforwarded(
    userId: string,
    overrides: Partial<{ event: string; props: Record<string, unknown>; schemaVersion: number }> = {},
  ): Promise<number> {
    const result = await harness.db.query<{ id: number }>(
      `INSERT INTO analytics_events (user_id, event, props, client_ts, event_id, schema_version)
       VALUES ($1, $2, $3, now(), $4, $5)
       RETURNING id`,
      [
        userId,
        overrides.event ?? 'sync_completed',
        JSON.stringify(overrides.props ?? { pushed: 1, pulled: 0, conflicts: 0 }),
        crypto.randomUUID(),
        overrides.schemaVersion ?? 1,
      ],
    );
    return result.rows[0]!.id;
  }

  async function forwardedAt(id: number): Promise<Date | null> {
    const result = await harness.db.query<{ practice_forwarded_at: Date | null }>(
      'SELECT practice_forwarded_at FROM analytics_events WHERE id = $1',
      [id],
    );
    return result.rows[0]!.practice_forwarded_at;
  }

  it('мост выключен (null) — ничего не трогает, {attempted:0, forwarded:0}', async () => {
    const user = await createUser(harness);
    await insertUnforwarded(user.userId);

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: null });
    expect(result).toEqual({ attempted: 0, forwarded: 0 });
  });

  it('непереслaнная строка — переслана и помечена practice_forwarded_at', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId, { event: 'note_saved', props: { length_bucket: 'm', encrypted: false } });

    const captured: PracticeEnvelope[] = [];
    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async (_url, init) => {
      captured.push(JSON.parse(String(init?.body)) as PracticeEnvelope);
      return new Response('{}', { status: 200 });
    });

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });

    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.forwarded).toBeGreaterThanOrEqual(1);
    expect(captured.some((e) => e.event === 'note_saved' && e.product === 'zapiski')).toBe(true);
    expect(await forwardedAt(id)).not.toBeNull();
  });

  it('уже переслaнная строка — не подхватывается снова', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId);
    await harness.db.query('UPDATE analytics_events SET practice_forwarded_at = now() WHERE id = $1', [id]);

    let calls = 0;
    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    });

    await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });
    expect(calls).toBe(0);
  });

  it('ПРАКТИКА снова недоступна — строка остаётся непереслaнной для следующего sweep, ничего не бросает', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId);

    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });
    expect(result.forwarded).toBe(0);
    expect(await forwardedAt(id)).toBeNull();
  });
});
