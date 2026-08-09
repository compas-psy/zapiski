import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, createUser, noDatabase, type Harness, type TestUser } from './helpers/app.ts';

/**
 * Blob-синк (ТЗ §4.1) и оптимистичная блокировка.
 *
 * If-Match — то, чем `SyncBackend.put(path, data, ifMatch?)` защищается от
 * гонки двух устройств. Расхождение etag обязано давать 412, а не тихую
 * перезапись: потеря правки на этом шаге — это ровно тот класс дефектов,
 * который ТЗ §2.1.4 запрещает («конфликты не теряют данные — никогда»).
 */

describe.skipIf(noDatabase())('blob-синк', () => {
  let harness: Harness;
  let user: TestUser;

  beforeAll(async () => {
    harness = await createHarness();
    user = await createUser(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const put = (path: string, body: Buffer, headers: Record<string, string> = {}) =>
    harness.app.inject({
      method: 'PUT',
      url: `/api/v1/vault/blob/${path}`,
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream', ...headers },
      payload: body,
    });

  it('запись и чтение возвращают те же байты и тот же etag', async () => {
    const payload = Buffer.from('ZPSKзашифрованные байты', 'utf8');
    const written = await put('Проекты/Идея.md.enc', payload);
    expect(written.statusCode).toBe(200);

    const meta = written.json() as { etag: string; size: number; path: string };
    expect(meta.size).toBe(payload.byteLength);
    expect(meta.path).toBe('Проекты/Идея.md.enc');
    expect(written.headers['etag']).toBe(meta.etag);

    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/Проекты/Идея.md.enc',
      headers: user.authHeader,
    });
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload.equals(payload)).toBe(true);
    expect(read.headers['etag']).toBe(meta.etag);
  });

  it('If-Match с верным etag пропускает запись', async () => {
    const first = await put('заметка-a.md.enc', Buffer.from('версия 1'));
    const etag = (first.json() as { etag: string }).etag;

    const second = await put('заметка-a.md.enc', Buffer.from('версия 2'), { 'if-match': etag });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { etag: string }).etag).not.toBe(etag);
  });

  it('If-Match с чужим etag даёт 412 и не трогает содержимое', async () => {
    const first = await put('заметка-b.md.enc', Buffer.from('исходная версия'));
    const etag = (first.json() as { etag: string }).etag;

    const conflicting = await put('заметка-b.md.enc', Buffer.from('перезапись'), {
      'if-match': '"совсем-другой-etag"',
    });
    expect(conflicting.statusCode).toBe(412);
    expect((conflicting.json() as { error: { code: string } }).error.code).toBe('etag_mismatch');

    // Содержимое осталось прежним — 412 это не «почти записали».
    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/заметка-b.md.enc',
      headers: user.authHeader,
    });
    expect(read.rawPayload.toString()).toBe('исходная версия');
    expect(read.headers['etag']).toBe(etag);
  });

  it('If-Match на несуществующий путь даёт 412', async () => {
    const response = await put('нет-такого.md.enc', Buffer.from('данные'), {
      'if-match': '"какой-то"',
    });
    expect(response.statusCode).toBe(412);
  });

  it('If-None-Match: * не даёт затереть существующий путь', async () => {
    await put('заметка-c.md.enc', Buffer.from('первая'));
    const response = await put('заметка-c.md.enc', Buffer.from('вторая'), {
      'if-none-match': '*',
    });
    expect(response.statusCode).toBe(412);
  });

  it('условный GET по If-None-Match отвечает 304', async () => {
    const written = await put('заметка-d.md.enc', Buffer.from('содержимое'));
    const etag = (written.json() as { etag: string }).etag;

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/заметка-d.md.enc',
      headers: { ...user.authHeader, 'if-none-match': etag },
    });
    expect(response.statusCode).toBe(304);
  });

  it('манифест отдаёт RemoteEntry и учитывает удаление', async () => {
    const fresh = await createUser(harness);
    const authed = { ...fresh.authHeader, 'content-type': 'application/octet-stream' };

    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/один.md.enc',
      headers: authed,
      payload: Buffer.from('один'),
    });
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/папка/два.md.enc',
      headers: authed,
      payload: Buffer.from('два'),
    });

    const manifest = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: fresh.authHeader,
    });
    expect(manifest.statusCode).toBe(200);

    const body = manifest.json() as {
      entries: Array<{ path: string; etag: string; mtime: number; size: number }>;
      quota: { usedBytes: number; limitBytes: number };
    };
    expect([...body.entries.map((e) => e.path)].sort()).toEqual(
      ['один.md.enc', 'папка/два.md.enc'].sort(),
    );
    for (const entry of body.entries) {
      expect(typeof entry.etag).toBe('string');
      expect(entry.mtime).toBeGreaterThan(0);
      expect(entry.size).toBeGreaterThan(0);
    }
    expect(body.quota.limitBytes).toBe(10 * 1024 * 1024 * 1024);

    const removed = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/vault/blob/один.md.enc',
      headers: fresh.authHeader,
    });
    expect(removed.statusCode).toBe(204);

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: fresh.authHeader,
    });
    const afterBody = after.json() as { entries: Array<{ path: string }> };
    expect(afterBody.entries.map((e) => e.path)).toEqual(['папка/два.md.enc']);

    const gone = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/один.md.enc',
      headers: fresh.authHeader,
    });
    expect(gone.statusCode).toBe(404);
  });

  it('пути с выходом за корень отклоняются', async () => {
    for (const bad of ['../секрет', 'папка/../../секрет', '..%2fсекрет']) {
      const response = await put(bad, Buffer.from('данные'));
      expect([400, 404]).toContain(response.statusCode);
    }
  });

  it('чужой блоб недоступен', async () => {
    const other = await createUser(harness);
    await put('приватная.md.enc', Buffer.from('моё'));

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/приватная.md.enc',
      headers: other.authHeader,
    });
    expect(response.statusCode).toBe(404);
  });

  it('без токена — 401', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
    });
    expect(response.statusCode).toBe(401);
  });

  it('CRDT-апдейты складываются и отдаются по курсору `since`', async () => {
    const fresh = await createUser(harness);
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/note-42',
      headers: { ...fresh.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([1, 2, 3, 4]),
    });
    expect(first.statusCode).toBe(201);
    const firstSeq = (first.json() as { seq: number }).seq;

    await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/note-42',
      headers: { ...fresh.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from([5, 6, 7]),
    });

    const all = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/crdt/note-42',
      headers: fresh.authHeader,
    });
    const body = all.json() as { updates: Array<{ seq: number; update: string }> };
    expect(body.updates).toHaveLength(2);
    // Байты возвращаются ровно те же — сервер их не трогает.
    expect(Buffer.from(body.updates[0]!.update, 'base64').equals(Buffer.from([1, 2, 3, 4]))).toBe(
      true,
    );

    const tail = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/vault/crdt/note-42?since=${firstSeq}`,
      headers: fresh.authHeader,
    });
    const tailBody = tail.json() as { updates: Array<{ seq: number }> };
    expect(tailBody.updates).toHaveLength(1);
  });

  it('блоб больше 64 МБ не принимается', async () => {
    const small = await createHarness({ env: { MAX_BLOB_BYTES: '1024' } });
    try {
      const owner = await createUser(small);
      const response = await small.app.inject({
        method: 'PUT',
        url: '/api/v1/vault/blob/большой.bin',
        headers: { ...owner.authHeader, 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(4096, 1),
      });
      expect(response.statusCode).toBe(413);
      expect((response.json() as { error: { code: string } }).error.code).toBe('blob_too_large');
    } finally {
      await small.close();
    }
  });
});
