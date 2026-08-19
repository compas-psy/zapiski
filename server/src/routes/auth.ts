import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { ApiError, errors } from '../lib/errors.ts';
import { signJwt, verifyJwt } from '../lib/jwt.ts';
import { mailSent } from '../lib/messages.ts';
import { isValidDeviceKey } from '../lib/vaultPath.ts';
import { describeMailError } from '../services/mailer.ts';
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
  recordConsents,
  upsertUserByEmail,
  upsertUserByYandex,
} from '../services/accounts.ts';
import { ensureSubscription } from '../services/subscription.ts';
import { ensureQuotaRow } from '../services/quota.ts';
import { YandexOAuthError } from '../services/yandex.ts';
import { renderAuthPage } from '../views/authPage.ts';

/**
 * Вход в аккаунт (ТЗ §5.5).
 *
 * Два пути и ни одного больше: Яндекс ID (основной) и magic-link на почту.
 * Паролей нет — нет ни экрана «придумайте пароль», ни «забыли пароль».
 * SMS нет нигде: ни эндпоинта, ни поля, ни зависимости.
 */

const PLATFORMS = ['web', 'windows', 'android'] as const;

/**
 * Ручка, которую открывает БРАУЗЕР, а не приложение.
 *
 * Таких три: `/auth/yandex`, `/auth/yandex/callback` и ссылка из письма
 * `/auth/magic-link/callback`. Всё, что они отвечают, человек видит глазами —
 * а отвечали они JSON. На истёкшей ссылке, на ссылке, открытой с другого
 * устройства, на невыданном client_id во весь экран показывалось
 * `{"error":{"code":"magic_link_expired", …}}`. Со стороны это ровно то, на
 * что жаловался заказчик: «авторизация через email в принципе ничего не
 * делает». Она делала — и говорила об этом на машинном языке.
 *
 * Обёртка переводит ошибку в страницу на языке продукта: текст берётся из того
 * же реестра BEHAVIOR §11, что и в приложении, и рядом ставится дорога назад.
 * Код ответа не меняется: сервер по-прежнему честно отвечает 410 или 400, и
 * тот, кто зовёт ручку программой, разбирает его как раньше.
 */
function browser(
  ctx: AppContext,
  title: string,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      /* `format=json` шлёт ПРИЛОЖЕНИЕ — ему нужен разбираемый ответ, а не
         страница. Условие то же, что у успешного ответа (`respondWithSession`),
         и другого различителя тут не надо: браузер этого параметра не ставит
         никогда, потому что ссылку собирает сервер. */
      const format = (request.query as { format?: unknown } | undefined)?.format;
      if (format === 'json') throw error;
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      return reply
        .code(error.statusCode)
        .type('text/html; charset=utf-8')
        .send(
          renderAuthPage({
            title,
            body: error.message,
            action: backToApp(ctx),
          }),
        );
    }
  };
}

/** Дорога назад со страницы возврата. `null` — некуда, и кнопки тогда нет. */
function backToApp(ctx: AppContext): { href: string; label: string } | null {
  const base = ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (base.length === 0) return null;
  return { href: `${base}/`, label: 'Открыть ЗАПИСКИ' };
}

const magicLinkBody = z.object({
  email: z.string().trim().min(3).max(254).email(),
  deviceId: z.string().refine(isValidDeviceKey, 'некорректный идентификатор устройства'),
  /**
   * Редакция принятого пользовательского соглашения и политики ПДн.
   *
   * ОБЯЗАТЕЛЬНО: аккаунт — это обработка персональных данных, и без согласия
   * заводить его нельзя. Хранится именно редакция, а не «да»: согласие даётся
   * на конкретный текст, и после его изменения прежнее согласие не становится
   * согласием на новый.
   */
  acceptedTerms: z.string().trim().min(1).max(64),
  /**
   * Рекламные письма — ОТДЕЛЬНОЕ и добровольное согласие. Необязательное поле
   * с умолчанием `false`: молчание согласием не является.
   */
  marketingOptIn: z.boolean().optional(),
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
  /* Те же два согласия, что и у входа по почте. Едут в подписанном `state`:
     подменить их из браузера нельзя, а другого места между началом и
     возвратом у них нет. */
  terms: z.string().trim().min(1).max(64),
  marketing: z.enum(['0', '1']).optional(),
});

const yandexCallbackQuery = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(4096),
  error: z.string().optional(),
});

const refreshBody = z.object({ refreshToken: z.string().min(16).max(512) });
const analyticsBody = z.object({ optIn: z.boolean() });
/** Рекламное согласие: `false` — отзыв, и он обязан работать всегда. */
const marketingBody = z.object({ optIn: z.boolean() });

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
    const { email, deviceId, platform, acceptedTerms, marketingOptIn } = parsed.data;

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
        /* Согласия едут вместе с токеном: аккаунт заведётся при переходе по
           ссылке, и записать их раньше некуда — пользователя ещё нет. */
        termsVersion: acceptedTerms,
        marketingOptIn: marketingOptIn ?? false,
      },
      now,
    );

    const url = buildMagicLinkUrl(ctx, issued.token, deviceId);
    try {
      await ctx.mailer.sendMagicLink({
        to: email,
        url,
        ttlMinutes: Math.round(ctx.env.MAGIC_LINK_TTL_SECONDS / 60),
      });
    } catch (error) {
      // Почта отдельно от базы: письмо не ушло — токен бесполезен, гасим его,
      // чтобы пользователь мог повторить сразу, а не ждать минуту.
      /* Причина — в строке, а не только в комментарии ниже. Без неё «письмо
         не ушло» одинаково выглядит и когда релея нет, и когда он отверг
         отправителя, и когда упало рукопожатие TLS. Адрес получателя из
         текста отказа вычищается (`describeMailError`). */
      request.log.warn(
        { event: 'magic_link_send_failed', reason: describeMailError(error) },
        'письмо не ушло',
      );
      await ctx.db
        .query('DELETE FROM magic_tokens WHERE token_hash = $1', [hashOf(issued.token)])
        .catch(() => undefined);
      /*
       * Свой код, а не проброс отказа релея.
       *
       * Наружу уходил безымянный отказ, клиент показывал текст про
       * СИНХРОНИЗАЦИЮ, и человек искал причину где угодно, кроме почты.
       * Владельцу продукта доставалось ровно «вход по почте не работает» —
       * без единой зацепки, чинить это или ждать.
       *
       * Исходная ошибка остаётся в логе (`magic_link_send_failed`), наружу
       * идёт причина и рабочий путь: Яндекс ID почтового релея не касается.
       */
      throw errors.mailFailed();
    }

    return reply.code(202).send({
      sent: true,
      // Реестр BEHAVIOR §11, строка «Письмо не дошло».
      message: mailSent(email),
      expiresAt: issued.expiresAt.toISOString(),
      resendAfterSeconds: cooldown,
    });
  });

  app.get('/api/v1/auth/magic-link/callback', browser(ctx, 'Ссылка не сработала', async (request, reply) => {
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
    /* Согласия, данные при запросе ссылки, становятся фактом ровно здесь —
       когда аккаунт существует. Момент фиксируется наш, серверный. */
    await recordConsents(
      ctx.db,
      user.id,
      { termsVersion: result.termsVersion, marketingOptIn: result.marketingOptIn ?? undefined },
      ctx.now(),
    );
    const session = await issueSession(ctx, user.id, deviceKey, result.platform);
    return respondWithSession(ctx, reply, session, parsed.data.format, result.platform);
  }));

  // ───────────────────────────────────────────────────────────────────────────
  // Яндекс ID — основной путь входа
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Какие способы входа сервер реально умеет.
   *
   * Заведено после жалобы «вход через Яндекс не работает». Приложение
   * показывало кнопку всегда и по нажатию уводило человека в системный
   * браузер — а там, если у сервера нет client_id, лежит голый JSON
   * `404 yandex_not_configured`. Человек возвращался ни с чем и без единого
   * слова о причине.
   *
   * Ответ без аутентификации и без секретов: только факт наличия. Клиент по
   * нему прячет кнопку — скрытый элемент честнее ведущего в тупик
   * (BEHAVIOR §5.1).
   */
  app.get('/api/v1/auth/methods', async (_request, reply) =>
    reply.send({
      /* Только то, о чём можно судить наверняка: ключи Яндекса либо заданы,
         либо нет. Про почту здесь ничего не сообщается — у SMTP_HOST есть
         значение по умолчанию, и «настроен» по нему не отличить от
         «оставлен как есть». Врать о готовности хуже, чем молчать. */
      yandex: ctx.yandex !== null,
    }),
  );

  app.get('/api/v1/auth/yandex', browser(ctx, 'Вход через Яндекс не удался', async (request, reply) => {
    const yandex = ctx.yandex;
    if (yandex === null) throw errors.notFound('yandex_not_configured');

    const parsed = yandexStartQuery.safeParse(request.query);
    if (!parsed.success) throw errors.badRequest('device_id_required');

    // state — короткоживущий подписанный токен: он же переносит device_id,
    // поэтому отдельной таблицы под OAuth-состояния не нужно.
    const state = signJwt(
      {
        sub: 'oauth',
        terms: parsed.data.terms,
        marketing: parsed.data.marketing === '1',
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
  }));

  app.get('/api/v1/auth/yandex/callback', browser(ctx, 'Вход через Яндекс не удался', async (request, reply) => {
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
    await recordConsents(
      ctx.db,
      user.id,
      {
        termsVersion: typeof state.claims['terms'] === 'string' ? state.claims['terms'] : null,
        marketingOptIn: state.claims['marketing'] === true,
      },
      ctx.now(),
    );
    const session = await issueSession(ctx, user.id, deviceKey, platform);
    return respondWithSession(ctx, reply, session, undefined, platform);
  }));

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
      /* Согласия видны человеку: он вправе знать, что и когда дал, и отозвать
         добровольное. Без этого «отзыв в любой момент» — пустые слова. */
      termsVersion: user.terms_version,
      termsAcceptedAt: user.terms_accepted_at?.toISOString() ?? null,
      marketingOptIn: user.marketing_opt_in,
      createdAt: user.created_at.toISOString(),
      device: { id: auth.deviceId },
    });
  });

  /**
   * Рекламное согласие: дать и ОТОЗВАТЬ.
   *
   * Отзыв обязателен по закону и обязателен по-человечески: согласие, которое
   * нельзя снять, — не согласие. Ручка та же на оба действия, разница в теле.
   */
  app.post(
    '/api/v1/auth/marketing-consent',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const parsed = marketingBody.safeParse(request.body);
      if (!parsed.success) throw errors.badRequest('bad_consent');
      const auth = authOf(request);
      await recordConsents(
        ctx.db,
        auth.userId,
        { termsVersion: null, marketingOptIn: parsed.data.optIn },
        ctx.now(),
      );
      return reply.send({ marketingOptIn: parsed.data.optIn });
    },
  );

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
  const redirect = authReturnUrl(ctx.env, platform);
  if (format !== 'json' && redirect !== undefined && redirect.length > 0) {
    const fragment = new URLSearchParams({
      access_token: session.accessToken,
      refresh_token: session.refreshToken,
      expires_in: String(session.expiresIn),
    });
    const target = `${redirect}#${fragment.toString()}`;

    /*
     * Возврат в родное приложение — СТРАНИЦЕЙ, а не голым 302.
     *
     * Переход на `zapiski://…` браузер выполняет не всегда и по причинам, о
     * которых он человеку не сообщает: спросил разрешение и не дождался
     * ответа, отказал переходу, начатому из письма, не нашёл приложения.
     * Тогда после 302 не происходит ВООБЩЕ НИЧЕГО — ни приложения, ни
     * сообщения, ни кнопки. Заказчик описал это как «попадаешь на сайт, а не
     * в приложение».
     *
     * Страница переходит сама (`meta refresh`), а если переход не случился —
     * остаётся на экране с кнопкой, которую можно нажать руками. Вход к этому
     * моменту уже состоялся: токены в адресе, второй раз ничего не
     * запрашивается.
     *
     * `no-store`: в адресе кнопки едет сессия, и в кэше браузера ей не место.
     * Для https-возврата (веб) ничего не меняется — там 302 работает всегда.
     */
    if (isAppScheme(redirect)) {
      return reply
        .code(200)
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(
          renderAuthPage({
            title: 'Вы вошли',
            body: 'Открываем ЗАПИСКИ. Если приложение не открылось само — нажмите кнопку.',
            action: { href: target, label: 'Открыть ЗАПИСКИ' },
            refreshTo: target,
          }),
        );
    }

    return reply.redirect(target, 302);
  }
  /*
   * Адреса возврата нет, а спрашивал БРАУЗЕР — значит, `reply.send(session)`
   * напечатал бы человеку на весь экран его собственные токены доступа.
   * Показывать их нельзя никогда: экран фотографируют, вкладку показывают
   * коллеге, адрес попадает в историю. Вместо этого — страница «вернитесь в
   * приложение»: вход состоялся, приложение заберёт сессию само.
   *
   * JSON остаётся ровно там, где его и ждут: при `format=json`, то есть когда
   * ручку зовёт не браузер, а приложение.
   */
  if (format !== 'json') {
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(
        renderAuthPage({
          title: 'Вы вошли',
          body: 'Вернитесь в ЗАПИСКИ — приложение продолжит само.',
          action: backToApp(ctx),
        }),
      );
  }
  return reply.send(session);
}

/**
 * Платформы, куда возвращаются ПО СВОЕЙ СХЕМЕ, а не по https.
 *
 * Родное приложение — Windows и Android — обязано получить человека обратно
 * само, без участия браузера. Https-адрес это не гарантирует: Windows чужую
 * ссылку не перехватывает вовсе, а Android перехватывает только после
 * подтверждения владения доменом (`assetlinks.json` с отпечатком ключа, каким
 * подписан установленный APK). Пока подтверждения нет — Chrome показывает
 * сайт, и человек остаётся в браузере с сессией, которая нужна приложению.
 *
 * Так вход в родных приложениях и полагается замыкать: RFC 8252 прямо
 * называет собственную схему адресом возврата для установленного приложения.
 * Веб остаётся на https — там браузер и есть приложение.
 */
const APP_SCHEME_PLATFORMS = new Set<string>(['windows', 'android']);

/**
 * Адрес возврата ведёт в приложение по его схеме, а не в браузер.
 *
 * Различие важно ровно одним: по https браузер переходит сам и всегда, а по
 * чужой схеме — когда сочтёт нужным. Второй случай нельзя оставлять молчащим.
 */
export function isAppScheme(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url);
}

/**
 * Куда увести браузер после успешного входа.
 *
 * Вынесено отдельной функцией, потому что это единственное решение, в котором
 * платформы различаются, и его нужно проверять без базы: DB-тесты пропускаются
 * там, где Postgres нет, а ошибиться здесь — значит снова оставить человека в
 * браузере.
 */
export function authReturnUrl(
  env: {
    AUTH_SUCCESS_REDIRECT?: string | undefined;
    AUTH_SUCCESS_REDIRECT_APP?: string | undefined;
    AUTH_SUCCESS_REDIRECT_DESKTOP?: string | undefined;
  },
  platform: string | null,
): string | undefined {
  /* `_DESKTOP` — прежнее имя той же настройки: сервер с не обновлённым
     окружением обязан продолжать работать. */
  const app = env.AUTH_SUCCESS_REDIRECT_APP ?? env.AUTH_SUCCESS_REDIRECT_DESKTOP;
  if (platform !== null && APP_SCHEME_PLATFORMS.has(platform) && app !== undefined && app.length > 0) {
    return app;
  }
  return env.AUTH_SUCCESS_REDIRECT;
}

/**
 * Ссылка из письма.
 *
 * `device_id` кладётся в ссылку ВСЕГДА. Это осознанный размен, и вот почему
 * он неизбежен.
 *
 * Обмен токена требует device_id. Взять его неоткуда, кроме самой ссылки:
 * письмо открывает БРАУЗЕР, а `x-device-id` — заголовок, который ставит
 * приложение своим запросом. При переходе по ссылке из почты запрос делает
 * браузер, и никакого заголовка в нём нет ни на одной платформе.
 *
 * Прежняя редакция клала device_id только для Windows, полагая, что на вебе и
 * Android идентификатор подставит приложение. На вебе подставить его некому:
 * ссылка ведёт в API, а не в SPA, и переход по ней — обычная навигация. На
 * Android приложение перехватило бы ссылку только по подтверждённым App Links,
 * а подтверждения (`assetlinks.json` на домене) не было выложено — Chrome
 * открывал ссылку сам. Итог: вход по почте не замыкался нигде, кроме Windows,
 * и человек упирался в «Ссылка не сработала» либо оставался на сайте.
 *
 * Что теряется: привязка к устройству, с которого запросили вход. Ссылка
 * становится обычным magic-link'ом — кто ею завладел, тот и войдёт. Это
 * поведение magic-link'а по определению: доступ к почте и есть фактор. Что
 * остаётся: одноразовость (второй переход уже не работает) и короткий срок
 * жизни.
 *
 * Сам device_id секретом не является — его придумывает клиент и шлёт открытым
 * запросом, — так что в ссылке он не раскрывает ничего сверх токена.
 */
export function magicLinkUrl(baseUrl: string, token: string, deviceKey: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const query = new URLSearchParams({ token, device_id: deviceKey });
  return `${base}/api/v1/auth/magic-link/callback?${query.toString()}`;
}

function buildMagicLinkUrl(ctx: AppContext, token: string, deviceKey: string): string {
  return magicLinkUrl(ctx.env.PUBLIC_BASE_URL, token, deviceKey);
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
