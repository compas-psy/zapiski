import type { FastifyInstance } from 'fastify';

/**
 * `GET /health` — проба для Docker HEALTHCHECK и для nginx.
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
}
