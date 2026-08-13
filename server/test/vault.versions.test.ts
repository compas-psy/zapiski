import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pruneExpiredVersions } from '../src/routes/versions.ts';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * История версий (ТЗ §4.2): 30 дней на пробном периоде, 365 на подписке.
 *
 * Отдельно проверяется автоснимок при перезаписи: клиент присылает X-Note-Id,
 * и предыдущий шифротекст уезжает в историю — именно из этого потом собирается
 * экран `4h` («История версий»).
 */

describe.skipIf(noDatabase())('история версий', () => {
  let harness: Harness;

  beforeAll(async () => {
    /* Сроки хранения версий — часть тарифа (30 дней пробный, 365 платный), и
       различать их имеет смысл только при включённой оплате. По умолчанию она
       выключена, и всем даётся полный срок — это проверяется в mvp.free. */
    harness = await createHarness({ env: { BILLING_ENABLED: '1' } });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('перезапись с X-Note-Id кладёт предыдущую версию в историю', async () => {
    const user = await createUser(harness);
    const binary = { ...user.authHeader, 'content-type': 'application/octet-stream' };

    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/дневник.md.enc',
      headers: { ...binary, 'x-note-id': 'note-diary' },
      payload: Buffer.from('первая редакция'),
    });
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/дневник.md.enc',
      headers: { ...binary, 'x-note-id': 'note-diary' },
      payload: Buffer.from('вторая редакция'),
    });

    const list = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/versions/note-diary',
      headers: user.authHeader,
    });
    expect(list.statusCode).toBe(200);

    const body = list.json() as {
      versions: Array<{ id: string; noteId: string; takenAt: number; source: string; merged: boolean; size: number }>;
      retentionDays: number;
    };
    expect(body.versions).toHaveLength(1);
    expect(body.retentionDays).toBe(365);
    expect(body.versions[0]!.noteId).toBe('note-diary');
    expect(body.versions[0]!.merged).toBe(false);

    // Содержимое версии — прежний шифротекст, байт в байт.
    const content = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/versions/note-diary/${body.versions[0]!.id}`,
      headers: user.authHeader,
    });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.toString()).toBe('первая редакция');
    expect(content.headers['x-version-merged']).toBe('0');

    // А в самом блобе — новая редакция.
    const current = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/дневник.md.enc',
      headers: user.authHeader,
    });
    expect(current.rawPayload.toString()).toBe('вторая редакция');
  });

  it('явный снимок сохраняет source и merged (SCREENS §10b `4h`)', async () => {
    const user = await createUser(harness);
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-merge',
      headers: {
        ...user.authHeader,
        'content-type': 'application/octet-stream',
        'x-version-source': 'Redmi Note 12',
        'x-version-merged': '1',
        'x-vault-path': 'Практика/супервизия.md.enc',
      },
      payload: Buffer.from('результат автослияния'),
    });
    expect(created.statusCode).toBe(201);

    const snapshot = created.json() as { id: string; source: string; merged: boolean };
    expect(snapshot.source).toBe('Redmi Note 12');
    expect(snapshot.merged).toBe(true);

    const content = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/versions/note-merge/${snapshot.id}`,
      headers: user.authHeader,
    });
    expect(content.headers['x-version-merged']).toBe('1');
    expect(decodeURIComponent(String(content.headers['x-version-source']))).toBe('Redmi Note 12');
  });

  it('на пробном периоде срок хранения 30 дней, на подписке 365', async () => {
    const trialUser = await createUser(harness, { subscribed: false, trial: true });
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-trial',
      headers: { ...trialUser.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('снимок на пробном'),
    });
    expect(created.statusCode).toBe(201);

    const { rows } = await harness.db.query<{ expires_at: Date; taken_at: Date }>(
      `SELECT expires_at, taken_at FROM versions WHERE user_id = $1 AND note_id = 'note-trial'`,
      [trialUser.userId],
    );
    const days = (rows[0]!.expires_at.getTime() - rows[0]!.taken_at.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    const paidUser = await createUser(harness);
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-paid',
      headers: { ...paidUser.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('снимок на подписке'),
    });
    const paid = await harness.db.query<{ expires_at: Date; taken_at: Date }>(
      `SELECT expires_at, taken_at FROM versions WHERE user_id = $1 AND note_id = 'note-paid'`,
      [paidUser.userId],
    );
    const paidDays = (paid.rows[0]!.expires_at.getTime() - paid.rows[0]!.taken_at.getTime()) / 86_400_000;
    expect(Math.round(paidDays)).toBe(365);
  });

  it('просроченные версии убираются, живые остаются', async () => {
    const user = await createUser(harness);
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-sweep',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('свежая версия'),
    });
    // Вторая версия, которой затем проставим срок задним числом.
    const stale = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-sweep',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('старая версия, которую пора убрать'),
    });
    const staleId = (stale.json() as { id: string }).id;
    await harness.db.query(
      `UPDATE versions SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [staleId],
    );

    // Просроченная не видна ещё до уборки — выдача фильтрует по сроку.
    const beforeSweep = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/versions/note-sweep',
      headers: user.authHeader,
    });
    expect((beforeSweep.json() as { versions: unknown[] }).versions).toHaveLength(1);

    const removed = await pruneExpiredVersions(harness.ctx, new Date());
    expect(removed).toBeGreaterThanOrEqual(1);

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/versions/note-sweep',
      headers: user.authHeader,
    });
    expect((after.json() as { versions: unknown[] }).versions).toHaveLength(1);

    // Просроченная строка исчезла и из базы, а не только из выдачи.
    const { rows } = await harness.db.query(`SELECT 1 FROM versions WHERE id = $1`, [staleId]);
    expect(rows).toHaveLength(0);
  });

  it('чужую версию не отдаём', async () => {
    const owner = await createUser(harness);
    const stranger = await createUser(harness);

    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-private',
      headers: { ...owner.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('только моё'),
    });
    const id = (created.json() as { id: string }).id;

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/versions/note-private/${id}`,
      headers: stranger.authHeader,
    });
    expect(response.statusCode).toBe(404);
  });
});
