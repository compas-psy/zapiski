import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { analyticsBatchBody, deviceConsentBody } from '../lib/analytics-schema.ts';
import { tryAuthenticate } from '../plugins/auth.ts';
import { findUserById } from '../services/accounts.ts';
import { getDeviceConsent, setDeviceConsent } from '../services/analytics-device.ts';

/**
 * Приём событий продуктовой аналитики (ТЗ §6, O-260817-05).
 *
 * Три независимых замка, каждый обязателен сам по себе:
 *  1. `ANALYTICS_ENABLED` — фича-флаг, выключен по умолчанию (docs/dev/modules/server.md).
 *  2. Согласие конкретного владельца, проверяется на КАЖДЫЙ запрос, а не один
 *     раз при выдаче токена: отозвал — сервер перестаёт принимать
 *     немедленно, а не только клиент перестаёт слать.
 *  3. `analyticsBatchBody` — `.strict()`-схема на каждое поле события: лишнее
 *     поле, которым можно было бы протащить текст заметки, роняет весь
 *     батч `400`, а не откладывается в сторону молча.
 *
 * O-260817-15: владелец — аккаунт ИЛИ устройство, не обязательно первое.
 * Вход в проде не доведён, а ЗАПИСКИ — локальное приложение: с Bearer-токеном
 * ничего не поменялось (`users.analytics_opt_in`, как раньше), без токена
 * событие принимается по `device_id` — тому же, что клиент уже несёт для
 * входа (`SessionStore.deviceId()`), — если для него отдельно записано
 * согласие (`analytics_device_consent`, по модели O-260817-13 для cmpas.ru).
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const ctx: AppContext = app.ctx;

  app.post('/api/v1/analytics/events', async (request, reply) => {
    if (!ctx.env.ANALYTICS_ENABLED) throw errors.analyticsDisabled();

    const parsed = analyticsBatchBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_analytics_event');

    const auth = await tryAuthenticate(app, request);
    let userId: string | null = null;
    let deviceId: string | null = null;

    if (auth !== null) {
      const user = await findUserById(ctx.db, auth.userId);
      if (user === null || !user.analytics_opt_in) throw errors.analyticsDisabled();
      userId = auth.userId;
    } else {
      deviceId = parsed.data.device_id ?? null;
      if (deviceId === null) throw errors.badRequest('device_id_required');
      const optedIn = await getDeviceConsent(ctx.db, deviceId);
      if (!optedIn) throw errors.analyticsDisabled();
    }

    for (const event of parsed.data.events) {
      await ctx.db.query(
        'INSERT INTO analytics_events (user_id, device_id, event, props, client_ts) VALUES ($1, $2, $3, $4, $5)',
        [userId, deviceId, event.event, JSON.stringify(event.props), event.ts],
      );
    }

    return reply.send({ accepted: parsed.data.events.length });
  });

  /**
   * Согласие устройства без аккаунта (O-260817-15). Без токена сознательно:
   * до входа согласие в принципе не к чему привязать, кроме устройства.
   * Подделать чужой `device_id` ничего не даёт: событий по нему без
   * отдельного согласия для этого же `device_id` всё равно не будет.
   */
  app.post('/api/v1/analytics/device-consent', async (request, reply) => {
    if (!ctx.env.ANALYTICS_ENABLED) throw errors.analyticsDisabled();
    const parsed = deviceConsentBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_consent');
    await setDeviceConsent(ctx.db, parsed.data.device_id, parsed.data.opt_in);
    return reply.send({ analyticsOptIn: parsed.data.opt_in });
  });
}
