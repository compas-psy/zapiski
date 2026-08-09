import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { LiveEvent } from '../src/protocol.ts';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Websocket мгновенного синка `/api/v1/vault/live`.
 *
 * Требование задачи и ТЗ §6: наружу уходят **только имена путей**. Тест
 * держится за это буквально — сверяет, что в кадре нет присланных байтов.
 */

describe.skipIf(noDatabase())('websocket мгновенного синка', () => {
  let harness: Harness;
  let baseUrl: string;

  beforeAll(async () => {
    harness = await createHarness();
    await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const address = harness.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    baseUrl = `ws://127.0.0.1:${port}/api/v1/vault/live`;
  });

  afterAll(async () => {
    await harness.close();
  });

  function connect(token: string): Promise<{ socket: WebSocket; events: LiveEvent[] }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}?access_token=${encodeURIComponent(token)}`);
      const events: LiveEvent[] = [];
      socket.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString('utf8')) as LiveEvent | { type: 'ready' };
        if (parsed.type === 'ready') resolve({ socket, events });
        else events.push(parsed as LiveEvent);
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('сокет не ответил ready')), 5000).unref?.();
    });
  }

  const waitFor = async (events: LiveEvent[], count: number): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (events.length < count && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('уведомляет о записи и удалении, не раскрывая содержимого', async () => {
    const user = await createUser(harness);
    const { socket, events } = await connect(user.accessToken);

    try {
      const secret = 'СЕКРЕТНОЕ-СОДЕРЖИМОЕ-БЛОБА-1a2b3c';
      await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/vault/blob/Проекты/Идея.md.enc',
        headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
        payload: Buffer.from(secret),
      });
      await waitFor(events, 1);

      expect(events).toHaveLength(1);
      const changed = events[0]!;
      expect(changed.type).toBe('changed');
      if (changed.type === 'changed') {
        expect(changed.path).toBe('Проекты/Идея.md.enc');
        expect(changed.etag).toBeTruthy();
        expect(changed.mtime).toBeGreaterThan(0);
      }

      // В кадре только имя пути и метаданные — никакого содержимого.
      const frame = JSON.stringify(changed);
      expect(frame).not.toContain(secret);
      expect(frame).not.toContain('СЕКРЕТНОЕ');

      await harness.app.inject({
        method: 'DELETE',
        url: '/api/v1/vault/blob/Проекты/Идея.md.enc',
        headers: user.authHeader,
      });
      await waitFor(events, 2);
      expect(events[1]?.type).toBe('removed');
    } finally {
      socket.close();
    }
  });

  it('события одного аккаунта не текут в сокет другого', async () => {
    const first = await createUser(harness);
    const second = await createUser(harness);
    const a = await connect(first.accessToken);
    const b = await connect(second.accessToken);

    try {
      await harness.app.inject({
        method: 'PUT',
        url: '/api/v1/vault/blob/только-моё.md.enc',
        headers: { ...first.authHeader, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('данные'),
      });
      await waitFor(a.events, 1);

      expect(a.events).toHaveLength(1);
      expect(b.events).toHaveLength(0);
    } finally {
      a.socket.close();
      b.socket.close();
    }
  });

  it('без токена соединение закрывается кодом 4401', async () => {
    const closed = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(baseUrl);
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('сокет не закрылся')), 5000).unref?.();
    });
    expect(closed).toBe(4401);
  });

  it('отозванная сессия в сокет не пускается', async () => {
    const user = await createUser(harness);
    await harness.db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1`, [
      user.userId,
    ]);

    const closed = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${baseUrl}?access_token=${encodeURIComponent(user.accessToken)}`);
      socket.on('close', (code: number) => resolve(code));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('сокет не закрылся')), 5000).unref?.();
    });
    expect(closed).toBe(4401);
  });

  it('CRDT-апдейт даёт событие с noteId и курсором', async () => {
    const user = await createUser(harness);
    const { socket, events } = await connect(user.accessToken);
    try {
      await harness.app.inject({
        method: 'POST',
        url: '/api/v1/vault/crdt/note-live',
        headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
        payload: Buffer.from([1, 2, 3]),
      });
      await waitFor(events, 1);

      const event = events[0]!;
      expect(event.type).toBe('crdt');
      if (event.type === 'crdt') {
        expect(event.noteId).toBe('note-live');
        expect(event.seq).toBeGreaterThan(0);
      }
    } finally {
      socket.close();
    }
  });
});
