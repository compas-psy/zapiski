import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppContext } from './context.ts';
import { resolveTrustProxy } from './config/env.ts';
import { ApiError, errors } from './lib/errors.ts';
import { redactPaths, serializers } from './lib/logging.ts';
import { registerAuth } from './plugins/auth.ts';
import { registerAnalyticsRoutes } from './routes/analytics.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerBillingRoutes } from './routes/billing.ts';
import { registerFeedbackRoutes } from './routes/feedback.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerLegalRoutes } from './routes/legal.ts';
import { registerLiveRoute } from './routes/live.ts';
import { registerPublishRoutes } from './routes/publish.ts';
import { registerUpdateRoutes } from './routes/updates.ts';
import { registerSyncKeyRoutes } from './routes/sync-key.ts';
import { registerVaultRoutes } from './routes/vault.ts';
import { registerVersionRoutes } from './routes/versions.ts';

/**
 * Сборка приложения. Отделена от `index.ts`, чтобы тесты поднимали тот же
 * инстанс через `app.inject()`, без сокета и без сети.
 */

/** Тело обычного запроса невелико; блобы и публикации задают свой лимит. */
const DEFAULT_BODY_LIMIT = 256 * 1024;

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // ТЗ §6: в журнал не попадают ни содержимое, ни пути внутри vault'а.
    logger: {
      level: ctx.env.LOG_LEVEL,
      serializers,
      redact: { paths: redactPaths, censor: '[скрыто]' },
    },
    trustProxy: resolveTrustProxy(ctx.env.trustProxy),
    bodyLimit: DEFAULT_BODY_LIMIT,
    routerOptions: { ignoreTrailingSlash: true },
  });

  app.decorate('ctx', ctx);

  await ctx.blobs.ensureRoot();

  // ── Парсеры тела ───────────────────────────────────────────────────────────

  // Блобы, CRDT-апдейты и версии приходят сырыми байтами.
  app.addContentTypeParser(
    ['application/octet-stream', 'application/vnd.zapiski.blob'],
    { parseAs: 'buffer', bodyLimit: ctx.env.MAX_BLOB_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  // JSON разбираем сами, чтобы сохранить сырые байты: подпись вебхука ЮKassa
  // считается по ним, а не по повторной сериализации разобранного объекта.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw.toString('utf8')));
      } catch {
        done(errors.badRequest('bad_json'), undefined);
      }
    },
  );

  // ── Плагины ────────────────────────────────────────────────────────────────

  if (ctx.env.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: ctx.env.corsOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'authorization',
        'content-type',
        'if-match',
        'if-none-match',
        'x-device-id',
        'x-note-id',
        'x-vault-path',
        'x-version-source',
        'x-version-merged',
        'x-device-name',
      ],
      exposedHeaders: ['etag', 'x-version-taken-at', 'x-version-source', 'x-version-merged'],
    });
  }

  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });

  /**
   * Общий лимит запросов. На auth-эндпоинтах он ужесточён отдельным `onRoute`
   * ниже: вход — единственное место, где перебор чего-то стоит.
   */
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Ключ — IP; за nginx он берётся из X-Forwarded-For (trustProxy).
    keyGenerator: (request) => request.ip,
    // Синк — это много мелких запросов; не душим его вместе с логином.
    allowList: () => false,
    /*
     * Возвращать нужно САМУ ошибку, а не её тело.
     *
     * Плагин делает `throw params.errorResponseBuilder(...)`, а наш
     * обработчик ошибок узнаёт ответ по `instanceof ApiError`. С `.toBody()`
     * летел простой объект без `statusCode` и без класса — обработчик его не
     * узнавал и отвечал 500 «Сейчас не получилось» вместо 429 «Попробуйте
     * через 30 секунд», да ещё и без `retry-after`.
     *
     * Больнее всего это било по входу: у него свой, более жёсткий лимит (20
     * запросов за 5 минут, ниже), и человек, который несколько раз подряд
     * попросил письмо, получал не «подождите», а «сейчас не получилось». То
     * есть вход переставал работать ровно тогда, когда человек старался.
     */
    errorResponseBuilder: () => errors.tooManyAttempts(30),
  });

  // ── Заголовки безопасности ────────────────────────────────────────────────

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    // Публичная страница ставит свою CSP; API отдаёт запрещающую.
    if (request.url.startsWith('/p/')) return payload;

    /*
     * Наши СТРАНИЦЫ (документы для согласий, возврат после входа) — тоже HTML
     * и тоже со своим `<style>`. Под `default-src 'none'` этот стиль
     * блокируется, и человек получает голый текст без оформления: страница
     * работает, но выглядит поломкой продукта.
     *
     * Скриптов на них нет ни одного, поэтому послабление ровно одно —
     * инлайновый стиль. `script-src` в политике отсутствует вовсе, то есть
     * при `default-src 'none'` скрипт не выполнится, даже если появится.
     */
    const html = String(reply.getHeader('content-type') ?? '').includes('text/html');
    reply.header(
      'content-security-policy',
      html
        ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : "default-src 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  // ── Обработка ошибок ──────────────────────────────────────────────────────

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      return reply.code(error.statusCode).send(error.toBody());
    }

    const { code, statusCode } = error as { code?: string; statusCode?: number };

    // Fastify режет слишком большое тело раньше хендлера.
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
      const tooLarge = errors.blobTooLarge();
      return reply.code(tooLarge.statusCode).send(tooLarge.toBody());
    }
    // Лимитер отдаёт 429 своим путём — текст всё равно берём из реестра.
    if (code === 'FST_ERR_RATE_LIMIT' || statusCode === 429) {
      const limited = errors.tooManyAttempts(30);
      for (const [name, value] of Object.entries(limited.headers)) reply.header(name, value);
      return reply.code(limited.statusCode).send(limited.toBody());
    }
    if (code === 'FST_ERR_VALIDATION' || statusCode === 400) {
      const bad = errors.badRequest();
      return reply.code(bad.statusCode).send(bad.toBody());
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: { code: code ?? 'request_failed', message: errors.badRequest().message } });
    }

    // Наружу — нейтральный текст; подробности только в журнал.
    request.log.error({ err: error, event: 'unhandled_error' }, 'запрос упал');
    const internal = errors.internal();
    return reply.code(internal.statusCode).send(internal.toBody());
  });

  app.setNotFoundHandler((_request, reply) => {
    const notFound = errors.notFound();
    return reply.code(notFound.statusCode).send(notFound.toBody());
  });

  // ── Маршруты ──────────────────────────────────────────────────────────────

  registerAuth(app);

  await app.register(async (scope) => {
    // Вход — единственное место, где перебор что-то даёт. Отдельный, более
    // жёсткий лимит поверх глобального.
    await scope.register(rateLimit, {
      max: 20,
      timeWindow: '5 minutes',
      keyGenerator: (request) => request.ip,
      /* Сама ошибка, а не её тело — см. пояснение у глобального лимита. */
      errorResponseBuilder: () => errors.tooManyAttempts(30),
    });
    await registerAuthRoutes(scope);
  });

  await registerHealthRoutes(app);
  /* Документы для согласий: `/terms` и `/privacy`. Их открывает браузер по
     ссылке с экрана входа, поэтому они вне `/api` и без аутентификации. */
  await registerLegalRoutes(app);
  await registerSyncKeyRoutes(app);
  await registerVaultRoutes(app);
  await registerVersionRoutes(app);
  await registerLiveRoute(app);
  await registerBillingRoutes(app);
  await registerPublishRoutes(app);
  await registerUpdateRoutes(app);
  await registerFeedbackRoutes(app);
  await registerAnalyticsRoutes(app);

  return app;
}
