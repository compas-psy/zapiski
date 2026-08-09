import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { errors } from '../lib/errors.ts';
import { signJwt, verifyJwt } from '../lib/jwt.ts';
import { mailSent } from '../lib/messages.ts';
import { isValidDeviceKey } from '../lib/vaultPath.ts';
import { authOf } from '../plugins/auth.ts';
import {
  consumeMagicToken,
  createMagicToken,
  createSession,
  ensureDevice,
  findUserById,
  lastMagicTokenAt,
  revokeAllSessions,
  revokeByRefreshToken,
  rotateRefreshToken,
  upsertUserByEmail,
  upsertUserByYandex,
} from '../services/accounts.ts';
import { ensureSubscription } from '../services/subscription.ts';
import { ensureQuotaRow } from '../services/quota.ts';
import { YandexOAuthError } from '../services/yandex.ts';

/**
 * Вход в аккаунт (ТЗ §5.5).
 *
 * Два пути и ни одного больше: Яндекс ID (основной) и magic-link на почту.
 * Паролей нет — нет ни экрана «придумайте пароль», ни «забыли пароль».
 * SMS нет нигде: ни эндпоинта, ни поля, ни зависимости.
 */

const PLATFORMS = ['web', 'windows', 'android'] as const;

const magicLinkBody = z.object({
  email: z.string().trim().min(3).max(254).email(),
  deviceId: z.string().refine(isValidDeviceKey, 'некорректный идентификатор устройства'),
  platform: z.enum(PLATFORMS).optional(),
});

const callbackQuery = z.object({
  token: z.string().min(16).max(512),
  device_id: z.string().optional(),
  format: z.enum(['json', 'redirect']).optional(),
});

const yandexStartQuery = z.object({
  device_id: z.string().refine(isValidDeviceKey, 'некорректный идентификатор устройства'),
  platform: z.enum(PLATFORMS).optional(),
});

const yandexCallbackQuery = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(4096),
  error: z.string().optional(),
});

const refreshBody = z.object({ refreshToken: z.string().min(16).max(512) });
const analyticsBody = z.object({ optIn: z.boolean() });

export interface SessionResponse {
  accessToken: string;
  /** Секунды жизни access-токена. */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  user: { id: string; email: string; analyticsOptIn: boolean };
  device: { id: string };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // ───────────────────────────────────────────────────────────────────────────
  // Magic-link
  // ───────────────────────────────────────────────────────────────────────────

  app.post('/api/v1/auth/magic-link', async (request, reply) => {
    const parsed = magicLinkBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_email_or_device');
    const { email, deviceId, platform } = parsed.data;

    const now = ctx.now();
    const cooldown = ctx.env.MAGIC_LINK_COOLDOWN_SECONDS;
    const last = await lastMagicTokenAt(ctx.db, email);
    if (last !== null) {
      const elapsed = (now.getTime() - last.getTime()) / 1000;
      if (elapsed < cooldown) {
        // SCREENS §2: «Отправить снова» неактивна 60 с. То же самое на сервере,
        // иначе ограничение существует только в нашем же UI.
        throw errors.tooManyAttempts(cooldown - elapsed);
      }
    }

    const issued = await createMagicToken(
      ctx.db,
      {
        email,
        deviceKey: deviceId,
        platform: platform ?? null,
        ttlSeconds: ctx.env.MAGIC_LINK_TTL_SECONDS,
      },
      now,
    );

    const url = buildMagicLinkUrl(ctx, issued.token, deviceId, platform ?? null);
    try {
      await ctx.mailer.sendMagicLink({
        to: email,
        url,
        ttlMinutes: Math.round(ctx.env.MAGIC_LINK_TTL_SECONDS / 60),
      });
    } catch (error) {
      // Почта отдельно от базы: письмо не ушло — токен бесполезен, гасим его,
      // чтобы пользователь мог повторить сразу, а не ждать минуту.
      request.log.warn({ event: 'magic_link_send_failed' }, 'письмо не ушло');
      await ctx.db
        .query('DELETE FROM magic_tokens WHERE token_hash = $1', [hashOf(issued.token)])
        .catch(() => undefined);
      throw error;
    }

    return reply.code(202).send({
      sent: true,
      // Реестр BEHAVIOR §11, строка «Письмо не дошло».
      message: mailSent(email),
      expiresAt: issued.expiresAt.toISOString(),
      resendAfterSeconds: cooldown,
    });
  });

  app.get('/api/v1/auth/magic-link/callback', async (request, reply) => {
    const parsed = callbackQuery.safeParse(request.query);
    if (!parsed.success) throw errors.badRequest('bad_token');

    const deviceKey = parsed.data.device_id ?? headerDeviceId(request);
    if (deviceKey === undefined || !isValidDeviceKey(deviceKey)) {
      throw errors.badRequest('device_id_required');
    }

    const result = await consumeMagicToken(ctx.db, parsed.data.token, deviceKey, ctx.now());
    if (!result.ok) {
      // Все четыре причины показываются одним текстом реестра BEHAVIOR §11:
      // «Ссылка больше не действует. Прислать новую?». Различает их `code`.
      throw errors.magicLinkDead(
        result.reason === 'used'
          ? 'magic_link_used'
          : result.reason === 'device_mismatch'
            ? 'magic_link_device_mismatch'
            : 'magic_link_expired',
      );
    }

    const user = await upsertUserByEmail(ctx.db, result.email);
    const session = await issueSession(ctx, user.id, deviceKey, result.platform);
    return respondWithSession(ctx, reply, session, parsed.data.format, result.platform);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Яндекс ID — основной путь входа
  // ───────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/auth/yandex', async (request, reply) => {
    const yandex = ctx.yandex;
    if (yandex === null) throw errors.notFound('yandex_not_configured');

    const parsed = yandexStartQuery.safeParse(request.query);
    if (!parsed.success) throw errors.badRequest('device_id_required');

    // state — короткоживущий подписанный токен: он же переносит device_id,
    // поэтому отдельной таблицы под OAuth-состояния не нужно.
    const state = signJwt(
      {
        sub: 'oauth',
        sid: 'oauth',
        did: parsed.data.device_id,
        typ: 'oauth_state',
        platform: parsed.data.platform ?? null,
      },
      ctx.env.AUTH_SECRET,
      600,
      ctx.now().getTime(),
    );

    return reply.redirect(yandex.authorizeUrl(state), 302);
  });

  app.get('/api/v1/auth/yandex/callback', async (request, reply) => {
    const yandex = ctx.yandex;
    if (yandex === null) throw errors.notFound('yandex_not_configured');

    const parsed = yandexCallbackQuery.safeParse(request.query);
    if (!parsed.success) throw errors.badRequest('bad_oauth_callback');
    if (parsed.data.error !== undefined || parsed.data.code === undefined) {
      throw errors.badRequest('oauth_declined');
    }

    const state = verifyJwt(parsed.data.state, ctx.env.AUTH_SECRET, ctx.now().getTime());
    if (!state.ok || state.claims.typ !== 'oauth_state') throw errors.badRequest('bad_state');
    const deviceKey = state.claims.did;
    if (typeof deviceKey !== 'string' || !isValidDeviceKey(deviceKey)) {
      throw errors.badRequest('bad_state');
    }
    const platform = typeof state.claims['platform'] === 'string' ? state.claims['platform'] : null;

    let identity;
    try {
      identity = await yandex.exchange(parsed.data.code);
    } catch (error) {
      if (error instanceof YandexOAuthError) {
        request.log.warn({ event: 'yandex_oauth_failed', stage: error.stage }, 'вход не удался');
        throw errors.badRequest(`yandex_${error.stage}_failed`);
      }
      throw error;
    }

    const user = await upsertUserByYandex(ctx.db, identity.id, identity.email);
    const session = await issueSession(ctx, user.id, deviceKey, platform);
    return respondWithSession(ctx, reply, session, undefined, platform);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Сессии
  // ───────────────────────────────────────────────────────────────────────────

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_refresh_token');

    const rotated = await rotateRefreshToken(
      ctx.db,
      parsed.data.refreshToken,
      ctx.env.AUTH_REFRESH_TTL_SECONDS,
      ctx.now(),
    );
    if (!rotated.ok) throw errors.sessionExpired();

    const user = await findUserById(ctx.db, rotated.session.user_id);
    if (user === null) throw errors.sessionExpired();

    const accessToken = signJwt(
      { sub: user.id, sid: rotated.session.id, did: rotated.session.device_id, typ: 'access' },
      ctx.env.AUTH_SECRET,
      ctx.env.AUTH_ACCESS_TTL_SECONDS,
      ctx.now().getTime(),
    );

    const body: SessionResponse = {
      accessToken,
      expiresIn: ctx.env.AUTH_ACCESS_TTL_SECONDS,
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.expiresAt.toISOString(),
      user: { id: user.id, email: user.email, analyticsOptIn: user.analytics_opt_in },
      device: { id: rotated.session.device_id },
    };
    return reply.send(body);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_refresh_token');
    await revokeByRefreshToken(ctx.db, parsed.data.refreshToken);
    // Выход идемпотентен: повтор не считается ошибкой.
    return reply.code(204).send();
  });

  app.post(
    '/api/v1/auth/logout-all',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const auth = authOf(request);
      const count = await revokeAllSessions(ctx.db, auth.userId);
      return reply.send({ revoked: count });
    },
  );

  app.get('/api/v1/auth/me', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const user = await findUserById(ctx.db, auth.userId);
    if (user === null) throw errors.sessionExpired();
    return reply.send({
      id: user.id,
      email: user.email,
      analyticsOptIn: user.analytics_opt_in,
      createdAt: user.created_at.toISOString(),
      device: { id: auth.deviceId },
    });
  });

  /** ТЗ §6: аналитика opt-in. Выключена, пока пользователь не согласился. */
  app.post(
    '/api/v1/auth/analytics-consent',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const parsed = analyticsBody.safeParse(request.body);
      if (!parsed.success) throw errors.badRequest('bad_consent');
      const auth = authOf(request);
      await ctx.db.query('UPDATE users SET analytics_opt_in = $2, updated_at = now() WHERE id = $1', [
        auth.userId,
        parsed.data.optIn,
      ]);
      return reply.send({ analyticsOptIn: parsed.data.optIn });
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function issueSession(
  ctx: AppContext,
  userId: string,
  deviceKey: string,
  platform: string | null,
): Promise<SessionResponse> {
  const deviceId = await ensureDevice(ctx.db, userId, deviceKey, platform);
  await ensureSubscription(ctx.db, userId);
  await ensureQuotaRow(ctx.db, userId);

  const session = await createSession(
    ctx.db,
    { userId, deviceId, ttlSeconds: ctx.env.AUTH_REFRESH_TTL_SECONDS },
    ctx.now(),
  );
  const accessToken = signJwt(
    { sub: userId, sid: session.sessionId, did: deviceId, typ: 'access' },
    ctx.env.AUTH_SECRET,
    ctx.env.AUTH_ACCESS_TTL_SECONDS,
    ctx.now().getTime(),
  );

  const user = await findUserById(ctx.db, userId);
  if (user === null) throw errors.internal();

  return {
    accessToken,
    expiresIn: ctx.env.AUTH_ACCESS_TTL_SECONDS,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.expiresAt.toISOString(),
    user: { id: user.id, email: user.email, analyticsOptIn: user.analytics_opt_in },
    device: { id: deviceId },
  };
}

/**
 * По умолчанию отдаём JSON: эндпоинт зовёт приложение. Если задан
 * AUTH_SUCCESS_REDIRECT, браузер уводится по deep-link, а токены едут во
 * фрагменте — фрагмент не уходит на сервер и не оседает в логах nginx.
 *
 * Адрес возврата зависит от платформы, и одним значением тут не обойтись:
 * вебу и Android нужен `https://…/auth/callback` (у Android он же App Link,
 * у веба — обычная страница), а настольному приложению — только собственная
 * схема `zapiski://`. Платформа берётся из того же токена, которым вход
 * начинался, поэтому подменить её из браузера нельзя.
 */
function respondWithSession(
  ctx: AppContext,
  reply: FastifyReply,
  session: SessionResponse,
  format: 'json' | 'redirect' | undefined,
  platform: string | null,
): FastifyReply {
  const desktop = ctx.env.AUTH_SUCCESS_REDIRECT_DESKTOP;
  const redirect =
    platform !== null && CANNOT_CATCH_HTTPS.has(platform) && desktop !== undefined && desktop.length > 0
      ? desktop
      : ctx.env.AUTH_SUCCESS_REDIRECT;
  if (format !== 'json' && redirect !== undefined && redirect.length > 0) {
    const fragment = new URLSearchParams({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      expires_in: String(session.expiresIn),
    });
    return reply.redirect(`${redirect}#${fragment.toString()}`, 302);
  }
  return reply.send(session);
}

/**
 * Платформы, которые не могут перехватить https-ссылку из письма.
 *
 * Android умеет App Links, браузер — сам себе адресная строка; настольное
 * приложение не умеет ни того, ни другого: Windows отдаёт приложению только
 * собственную схему (`zapiski://`), а письмо открывается в браузере.
 */
const CANNOT_CATCH_HTTPS = new Set<string>(['windows']);

/**
 * Ссылка из письма.
 *
 * `device_id` кладётся в ссылку **только для настольного приложения** — и это
 * осознанный размен, а не недосмотр. Обмен требует device_id, а браузер, в
 * котором открылось письмо, идентификатор настольного приложения знать не
 * может: приложение ему ничего не передавало. Без этого параметра вход на
 * Windows не замыкается вообще.
 *
 * Что при этом теряется: на Windows ссылка становится обычным magic-link'ом —
 * кто ею завладел, тот и войдёт. На вебе и Android привязка к устройству
 * инициации сохраняется полностью: там device_id подставляет приложение, и
 * письмо, открытое на чужом устройстве, даёт `device_mismatch`.
 *
 * Сам device_id секретом не является (его придумывает клиент и шлёт открытым
 * запросом), так что добавление его в ссылку не раскрывает ничего сверх того,
 * что уже несёт сам токен.
 */
function buildMagicLinkUrl(
  ctx: AppContext,
  token: string,
  deviceKey: string,
  platform: string | null,
): string {
  const base = ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const query = new URLSearchParams({ token });
  if (platform !== null && CANNOT_CATCH_HTTPS.has(platform)) {
    query.set('device_id', deviceKey);
  }
  return `${base}/api/v1/auth/magic-link/callback?${query.toString()}`;
}

function headerDeviceId(request: FastifyRequest): string | undefined {
  const value = request.headers['x-device-id'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function hashOf(token: string): string {
  return sha256Hex(token);
}
