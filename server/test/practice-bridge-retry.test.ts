/**
 * Sweep-повтор пересылки в ПРАКТИКУ (C4, доведён E-Z2): `retryPracticeForwarding`
 * подбирает `analytics_events`, не дошедшие до `/ingest` с первой попытки
 * (`practice_forwarded_at IS NULL`) — маршрут проверяется отдельно
 * (`analytics.events.test.ts`), здесь — только сам механизм повтора, включая
 * пересылку пачками.
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

  async function rejectReason(id: number): Promise<string | null> {
    const result = await harness.db.query<{ practice_reject_reason: string | null }>(
      'SELECT practice_reject_reason FROM analytics_events WHERE id = $1',
      [id],
    );
    return result.rows[0]!.practice_reject_reason;
  }

  it('мост выключен (null) — ничего не трогает, {attempted:0, forwarded:0}', async () => {
    const user = await createUser(harness);
    await insertUnforwarded(user.userId);

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: null });
    expect(result).toEqual({ attempted: 0, forwarded: 0 });
  });

  it('непереслaнная строка — переслана и помечена practice_forwarded_at, конверт несёт event_id', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId, { event: 'note_saved', props: { length_bucket: 'm', encrypted: false } });

    const captured: PracticeEnvelope[] = [];
    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      captured.push(...sent);
      return new Response(JSON.stringify({ results: sent.map(() => ({ accepted: true })) }), { status: 200 });
    });

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });

    expect(result.attempted).toBeGreaterThanOrEqual(1);
    expect(result.forwarded).toBeGreaterThanOrEqual(1);
    const sent = captured.find((e) => e.event === 'note_saved' && e.product === 'zapiski');
    expect(sent).toBeDefined();
    expect(typeof sent?.event_id).toBe('string');
    expect(await forwardedAt(id)).not.toBeNull();
  });

  it('уже переслaнная строка — не подхватывается снова', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId);
    await harness.db.query('UPDATE analytics_events SET practice_forwarded_at = now() WHERE id = $1', [id]);

    let calls = 0;
    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async () => {
      calls += 1;
      return new Response(JSON.stringify({ results: [{ accepted: true }] }), { status: 200 });
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

  it('приёмник явно отвергает строку — не переслaна, но причина записана в practice_reject_reason (E-Z1: отличать от сетевого сбоя)', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId);

    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      return new Response(
        JSON.stringify({ results: sent.map(() => ({ accepted: false, reason: 'consent required for subject' })) }),
        { status: 200 },
      );
    });

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });
    expect(result.forwarded).toBe(0);
    expect(await forwardedAt(id)).toBeNull();
    expect(await rejectReason(id)).toBe('consent required for subject');
  });

  it('успешная пересылка после ранее записанного отказа очищает practice_reject_reason', async () => {
    const user = await createUser(harness);
    const id = await insertUnforwarded(user.userId);
    await harness.db.query('UPDATE analytics_events SET practice_reject_reason = $2 WHERE id = $1', [
      id,
      'consent required for subject',
    ]);

    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      return new Response(JSON.stringify({ results: sent.map(() => ({ accepted: true })) }), { status: 200 });
    });

    await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });
    expect(await forwardedAt(id)).not.toBeNull();
    expect(await rejectReason(id)).toBeNull();
  });

  it('E-Z2: 450 непереслaнных строк одного sweep-вызова — три HTTP-запроса [200, 200, 50], помечены ровно принятые', async () => {
    // Чистый срез: предыдущие наборы этого файла (сценарии отказа выше)
    // могли оставить единичные непереслaнные строки как честный побочный
    // эффект своих проверок — `fileParallelism: false` (vitest.config.ts)
    // гарантирует, что ни один другой файл сейчас не пишет в ту же таблицу
    // параллельно, так что точный подсчёт здесь безопасен только после
    // явной очистки текущего бэклога, а не полагаясь на угаданный ноль.
    await harness.db.query('DELETE FROM analytics_events WHERE practice_forwarded_at IS NULL');

    const user = await createUser(harness);
    const ids: number[] = [];
    for (let i = 0; i < 450; i += 1) {
      ids.push(await insertUnforwarded(user.userId, { props: { pushed: i, pulled: 0, conflicts: 0 } }));
    }

    const requestSizes: number[] = [];
    // Каждый второй конверт в каждом запросе отвергается — чтобы проверить,
    // что помечены ИМЕННО принятые, а не весь чанк оптом.
    const bridge = new PracticeBridge('https://practice.test/api/ingest', 'shh', async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as PracticeEnvelope[];
      requestSizes.push(sent.length);
      const results = sent.map((_, i) => (i % 2 === 0 ? { accepted: true } : { accepted: false, reason: 'consent required' }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    });

    const result = await retryPracticeForwarding({ db: harness.db, practiceBridge: bridge });

    expect(requestSizes).toEqual([200, 200, 50]);
    expect(result.attempted).toBe(450);
    // 100 принятых на каждый из двух полных чанков по 200 (чётные позиции
    // 0,2,…,198) плюс 25 на неполном чанке из 50 — итого 225.
    expect(result.forwarded).toBe(225);

    const marks = await Promise.all(ids.map((id) => forwardedAt(id)));
    expect(marks.filter((m) => m !== null)).toHaveLength(225);
    // Строки идут в порядке id (ORDER BY id), чанки — срезы подряд по 200,
    // так что чётность позиции внутри всей выборки совпадает с чётностью
    // позиции внутри собственного чанка (200 — чётное число).
    expect(marks[0]).not.toBeNull(); // чанк 1, локальный индекс 0 — принят
    expect(marks[1]).toBeNull(); // чанк 1, локальный индекс 1 — отвергнут
    expect(marks[400]).not.toBeNull(); // чанк 3, локальный индекс 0 — принят
    expect(marks[449]).toBeNull(); // чанк 3, локальный индекс 49 — отвергнут
  });
});
