import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import { verifyJwt } from '../lib/jwt.ts';
import { extractTokenForWebSocket } from '../plugins/auth.ts';
import { findSessionById } from '../services/accounts.ts';
import type { LiveEvent } from '../protocol.ts';

/**
 * Websocket мгновенного синка: `/api/v1/vault/live`.
 *
 * ТЗ §6 и требование задачи: наружу уходят **только имена путей** и служебные
 * идентификаторы. Содержимого здесь нет и быть не может — сервер его не имеет.
 * Клиент, получив событие, сам решает, что перекачать.
 *
 * Сокет ничего не принимает, кроме `ping`: канал односторонний, чтобы не
 * заводить второй путь записи в обход HTTP с его проверками подписки и квоты.
 */

/** Коды закрытия — по RFC 6455, диапазон приложения 4000+. */
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_SESSION_GONE = 4403;

const HEARTBEAT_MS = 30_000;

export async function registerLiveRoute(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get('/api/v1/vault/live', { websocket: true }, async (socket: WebSocket, request) => {
    const auth = await authenticate(app, request);
    if (auth === null) {
      socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const unsubscribe = ctx.live.subscribe(auth.userId, (event: LiveEvent) => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // Разрыв на записи — сокет всё равно закроется, чистка ниже.
      }
    });

    socket.send(JSON.stringify({ type: 'ready', deviceId: auth.deviceId }));

    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    socket.on('pong', () => {
      alive = true;
    });

    socket.on('message', (raw: Buffer) => {
      alive = true;
      // Единственное, на что реагируем, — прикладной ping от клиента.
      if (raw.length <= 64 && raw.toString('utf8').includes('ping')) {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

interface LiveAuth {
  userId: string;
  deviceId: string;
}

/**
 * Браузерный WebSocket не умеет ставить заголовки, поэтому токен принимается и
 * в query. В журнал он не попадает: `access_token` вычищается сериализатором.
 */
async function authenticate(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<LiveAuth | null> {
  const token = extractTokenForWebSocket(request);
  if (token === null) return null;

  const verified = verifyJwt(token, app.ctx.env.AUTH_SECRET, app.ctx.now().getTime());
  if (!verified.ok || verified.claims.typ !== 'access') return null;

  const { sub, sid, did } = verified.claims;
  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof did !== 'string') return null;

  const session = await findSessionById(app.ctx.db, sid);
  if (session === null || session.user_id !== sub) return null;
  if (session.revoked_at !== null) return null;
  if (session.expires_at.getTime() <= app.ctx.now().getTime()) return null;

  return { userId: sub, deviceId: did };
}

export { CLOSE_SESSION_GONE, CLOSE_UNAUTHORIZED };
