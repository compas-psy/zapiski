import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { verifyJwt } from '../lib/jwt.ts';
import { findSessionById } from '../services/accounts.ts';

/**
 * Проверка access-токена.
 *
 * JWT подтверждает подпись, но не отвечает на вопрос «сессию не отозвали?».
 * Поэтому после проверки подписи сессия сверяется с базой: отзыв должен
 * действовать сразу, а не через 15 минут, когда протухнет токен.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorate('requireAuth', async (request: FastifyRequest) => {
    const token = extractToken(request);
    if (token === null) throw errors.authRequired();

    const verified = verifyJwt(token, app.ctx.env.AUTH_SECRET, app.ctx.now().getTime());
    if (!verified.ok) {
      throw verified.reason === 'expired' ? errors.sessionExpired() : errors.authRequired();
    }
    const claims = verified.claims;
    if (claims.typ !== 'access') throw errors.authRequired();
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.sid !== 'string' ||
      typeof claims.did !== 'string'
    ) {
      throw errors.authRequired();
    }

    const session = await findSessionById(app.ctx.db, claims.sid);
    if (session === null || session.user_id !== claims.sub) throw errors.authRequired();
    if (session.revoked_at !== null) throw errors.sessionExpired();
    if (session.expires_at.getTime() <= app.ctx.now().getTime()) throw errors.sessionExpired();

    const auth: AuthContext = {
      userId: claims.sub,
      sessionId: claims.sid,
      deviceId: claims.did,
    };
    request.auth = auth;
  });
}

/** Достаёт токен для обычного запроса. */
export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const [scheme, value] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value !== undefined && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * То же для websocket: браузерный WebSocket не умеет задавать заголовки, так
 * что для `/vault/live` токен разрешён и в query. В журнал он не попадает —
 * `access_token` вычищается сериализатором (ТЗ §6).
 */
export function extractTokenForWebSocket(request: FastifyRequest): string | null {
  const fromHeader = extractToken(request);
  if (fromHeader !== null) return fromHeader;

  const query = request.query as Record<string, unknown> | undefined;
  const candidate = query?.['access_token'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** Гарантированно непустой контекст. Вызывать только после `requireAuth`. */
export function authOf(request: FastifyRequest): AuthContext {
  const auth = request.auth;
  if (auth === undefined) throw errors.authRequired();
  return auth;
}
