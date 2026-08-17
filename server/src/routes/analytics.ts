import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { analyticsBatchBody } from '../lib/analytics-schema.ts';
import { authOf } from '../plugins/auth.ts';
import { findUserById } from '../services/accounts.ts';

/**
 * Приём событий продуктовой аналитики (ТЗ §6, O-260817-05).
 *
 * Три независимых замка, каждый обязателен сам по себе:
 *  1. `ANALYTICS_ENABLED` — фича-флаг, выключен по умолчанию (docs/dev/modules/server.md).
 *  2. `users.analytics_opt_in` — согласие конкретного человека, проверяется
 *     на КАЖДЫЙ запрос, а не один раз при выдаче токена: отозвал — сервер
 *     перестаёт принимать немедленно, а не только клиент перестаёт слать.
 *  3. `analyticsBatchBody` — `.strict()`-схема на каждое поле события: лишнее
 *     поле, которым можно было бы протащить текст заметки, роняет весь
 *     батч `400`, а не откладывается в сторону молча.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const ctx: AppContext = app.ctx;

  app.post('/api/v1/analytics/events', { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.env.ANALYTICS_ENABLED) throw errors.analyticsDisabled();

    const auth = authOf(request);
    const user = await findUserById(ctx.db, auth.userId);
    if (user === null || !user.analytics_opt_in) throw errors.analyticsDisabled();

    const parsed = analyticsBatchBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_analytics_event');

    for (const event of parsed.data.events) {
      await ctx.db.query(
        'INSERT INTO analytics_events (user_id, event, props, client_ts) VALUES ($1, $2, $3, $4)',
        [auth.userId, event.event, JSON.stringify(event.props), event.ts],
      );
    }

    return reply.send({ accepted: parsed.data.events.length });
  });
}
