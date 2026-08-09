import type { FastifyInstance } from 'fastify';

/**
 * `GET /health` и `GET /api/v1/health` — одна и та же проба по двум адресам.
 *
 * Внутри контейнера Docker HEALTHCHECK ходит по короткому `/health`.
 * Снаружи запрос идёт через nginx, который проксирует `/api/` на этот сервис
 * БЕЗ срезания префикса, — значит наружу проба доступна как `/api/v1/health`,
 * единообразно с остальным API. Регистрируем оба, иначе один из двух путей
 * молча отдаёт 404: именно на этом контейнер не становился healthy.
 *
 * Проверяет то, без чего сервис бесполезен: живое соединение с базой и
 * доступность тома. Ни аутентификации, ни пользовательских данных в ответе.
 */

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const startedAt = Date.now();

  app.get('/health', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    try {
      await ctx.db.query('SELECT 1');
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'fail';
    }

    try {
      await ctx.blobs.ensureRoot();
      checks['blobs'] = 'ok';
    } catch {
      checks['blobs'] = 'fail';
    }

    const healthy = Object.values(checks).every((value) => value === 'ok');
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
    });
  });

  /** Готовность принимать трафик — отдельно от «жив ли процесс». */
  app.get('/health/live', async (_request, reply) => reply.send({ status: 'ok' }));

  // Те же пробы под префиксом API — для nginx и внешнего мониторинга.
  app.get('/api/v1/health', async (request, reply) =>
    app.inject({ method: 'GET', url: '/health' }).then((r) =>
      reply.code(r.statusCode).headers({ 'content-type': 'application/json' }).send(r.body),
    ),
  );
  app.get('/api/v1/health/live', async (_request, reply) => reply.send({ status: 'ok' }));
}
