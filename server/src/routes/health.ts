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

  /*
   * Причина отказа почты пишется в журнал — но не на каждую пробу.
   *
   * `/health` дёргает HEALTHCHECK контейнера раз в полминуты; если писать
   * каждый раз, журнал за сутки превращается в две тысячи одинаковых строк, и
   * настоящая смена состояния в них тонет. Поэтому строка появляется только
   * когда причина ИЗМЕНИЛАСЬ — включая переход в «почта снова работает».
   */
  let reportedMailFailure: string | null = null;

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

    /*
     * Почта проверяется, но НЕ роняет пробу.
     *
     * Без релея сервис остаётся полезным: заметки синхронизируются, вход через
     * Яндекс ID работает. Ронять контейнер из-за почты значило бы выключить
     * рабочее облако из-за неработающего письма. Поэтому `mail` попадает в
     * ответ отдельным полем: мониторинг его видит, а `status` от него не
     * зависит.
     */
    let mail: 'ok' | 'fail';
    try {
      mail = (await ctx.mailer.verify()) ? 'ok' : 'fail';
    } catch {
      mail = 'fail';
    }

    /*
     * Наружу отдаётся только `ok`/`fail`: `/api/v1/health` открыт всему миру,
     * и адрес внутреннего релея вместе с текстом ошибки транспорта — не то,
     * что стоит показывать по чужому запросу. Тому, кто чинит, причина видна
     * в журнале контейнера.
     */
    const failure = mail === 'fail' ? (ctx.mailer.lastFailure() ?? 'причина неизвестна') : null;
    if (failure !== reportedMailFailure) {
      reportedMailFailure = failure;
      if (failure === null) {
        app.log.info('mail_relay_ok');
      } else {
        app.log.warn({ reason: failure }, 'mail_relay_unavailable');
      }
    }

    const healthy = Object.values(checks).every((value) => value === 'ok');
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks,
      /* `mail: 'fail'` — вход по почте сейчас не работает, и причина вне
         приложения: релей недоступен или не пускает. Яндекс ID при этом жив. */
      mail,
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
