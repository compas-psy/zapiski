import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readUsage, recalculate } from '../src/services/quota.ts';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Квота (ТЗ §7: 10 ГБ для подписчиков).
 *
 * Проверяется не только «перебор отклоняется», но и то, что счётчик честный:
 * перезапись меняет расход на разницу, а не на полный размер, удаление место
 * возвращает, и после всех операций счётчик сходится с фактом в таблицах.
 * Разъехавшийся счётчик хуже отсутствующего — он запрещает запись там, где
 * место на самом деле есть.
 */

describe.skipIf(noDatabase())('квота', () => {
  let harness: Harness;

  beforeAll(async () => {
    // Маленький лимит: проверяем логику, а не терпение диска.
    harness = await createHarness({ env: { QUOTA_BYTES: '4096', MAX_BLOB_BYTES: '4096' } });
  });

  afterAll(async () => {
    await harness.close();
  });

  const put = (token: Record<string, string>, path: string, body: Buffer) =>
    harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${path}`,
      headers: { ...token, 'content-type': 'application/octet-stream' },
      payload: body,
    });

  it('запись сверх лимита отклоняется с 507', async () => {
    const user = await createUser(harness);

    const first = await put(user.authHeader, 'a.bin', Buffer.alloc(3000, 1));
    expect(first.statusCode).toBe(200);

    const overflow = await put(user.authHeader, 'b.bin', Buffer.alloc(2000, 2));
    expect(overflow.statusCode).toBe(507);
    expect((overflow.json() as { error: { code: string } }).error.code).toBe('quota_exceeded');

    // Отказ не должен оставлять следов в манифесте.
    const manifest = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: user.authHeader,
    });
    const body = manifest.json() as { entries: Array<{ path: string }>; quota: { usedBytes: number } };
    expect(body.entries.map((e) => e.path)).toEqual(['a.bin']);
    expect(body.quota.usedBytes).toBe(3000);
  });

  it('перезапись считает разницу, а не полный размер', async () => {
    const user = await createUser(harness);

    await put(user.authHeader, 'растёт.bin', Buffer.alloc(3000, 1));
    expect((await readUsage(harness.db, user.userId)).totalBytes).toBe(3000);

    // 3000 → 3500: разница 500, влезает. Полный размер 3500+3000 не влез бы.
    const grown = await put(user.authHeader, 'растёт.bin', Buffer.alloc(3500, 2));
    expect(grown.statusCode).toBe(200);
    expect((await readUsage(harness.db, user.userId)).totalBytes).toBe(3500);

    const shrunk = await put(user.authHeader, 'растёт.bin', Buffer.alloc(100, 3));
    expect(shrunk.statusCode).toBe(200);
    expect((await readUsage(harness.db, user.userId)).totalBytes).toBe(100);
  });

  it('удаление возвращает место', async () => {
    const user = await createUser(harness);
    await put(user.authHeader, 'занимает.bin', Buffer.alloc(4000, 1));

    const blocked = await put(user.authHeader, 'ещё.bin', Buffer.alloc(500, 2));
    expect(blocked.statusCode).toBe(507);

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/vault/blob/занимает.bin',
      headers: user.authHeader,
    });
    expect(removed.statusCode).toBe(204);
    expect((await readUsage(harness.db, user.userId)).totalBytes).toBe(0);

    const allowed = await put(user.authHeader, 'ещё.bin', Buffer.alloc(500, 2));
    expect(allowed.statusCode).toBe(200);
  });

  it('CRDT-апдейты и версии тоже занимают место', async () => {
    const user = await createUser(harness);

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/note-quota',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1000, 7),
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-quota',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1500, 8),
    });

    const usage = await readUsage(harness.db, user.userId);
    expect(usage.crdtBytes).toBe(1000);
    expect(usage.versionBytes).toBe(1500);
    expect(usage.totalBytes).toBe(2500);

    const overflow = await put(user.authHeader, 'не-влезет.bin', Buffer.alloc(2000, 9));
    expect(overflow.statusCode).toBe(507);
  });

  it('счётчик сходится с фактом после серии операций', async () => {
    const user = await createUser(harness);

    await put(user.authHeader, 'один.bin', Buffer.alloc(500, 1));
    await put(user.authHeader, 'два.bin', Buffer.alloc(700, 2));
    await put(user.authHeader, 'один.bin', Buffer.alloc(300, 3));
    await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/vault/blob/два.bin',
      headers: user.authHeader,
    });
    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/n1',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(200, 4),
    });

    const tracked = await readUsage(harness.db, user.userId);
    const recomputed = await recalculate(harness.db, user.userId);

    expect(tracked.totalBytes).toBe(recomputed.totalBytes);
    expect(tracked.blobBytes).toBe(recomputed.blobBytes);
    expect(tracked.blobCount).toBe(recomputed.blobCount);
    expect(tracked.crdtBytes).toBe(recomputed.crdtBytes);
  });

  it('квота считается по каждому аккаунту отдельно', async () => {
    const first = await createUser(harness);
    const second = await createUser(harness);

    await put(first.authHeader, 'полный.bin', Buffer.alloc(4000, 1));
    const other = await put(second.authHeader, 'свой.bin', Buffer.alloc(4000, 2));
    expect(other.statusCode).toBe(200);
  });
});
