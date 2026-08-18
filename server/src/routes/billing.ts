import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { authOf } from '../plugins/auth.ts';
import type { BillingStatus } from '../protocol.ts';
import { quotaStatus } from '../services/quota.ts';
import { trialDaysFor } from '../lib/trial.ts';
import {
  activatePaidPeriod,
  cancelAutoRenew,
  ensureSubscription,
  getEntitlement,
  markPaymentFailed,
  startTrial,
} from '../services/subscription.ts';
import {
  amountRub,
  createPayment,
  newOrderId,
  parseNotification,
  periodEnd,
  verifyNotification,
  type TbankCredentials,
} from '../services/tbank.ts';

/**
 * Подписка (ТЗ §5.5). 299 ₽/мес, 224 ₽/мес при годовой оплате.
 *
 * Эквайринг один на весь портфель — Т-Касса (решение учредителя 18.08.2026).
 * ЮKassa и Google Play Billing удалены вместе с кодом: у Google с декабря 2024
 * нет выплат российским разработчикам, и держать мёртвый путь оплаты опаснее,
 * чем не иметь его вовсе.
 *
 * Главное правило, которое этот модуль обязан сохранять: **истечение подписки
 * не блокирует данные**. Здесь считается только `canWrite`; ни один эндпоинт
 * чтения в облаке на него не смотрит. SCREENS §9 прямо запрещает «блокировку
 * доступа к уже созданным заметкам».
 */

const planSchema = z.enum(['monthly', 'yearly']);
const paymentBody = z.object({
  plan: planSchema,
  successUrl: z.string().url(),
  failUrl: z.string().url(),
});

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get('/api/v1/billing/status', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    return reply.send(await buildStatus(ctx, auth.userId));
  });

  /*
   * Ниже — всё, что берёт деньги или начинает отсчёт. Пока оплата выключена,
   * эти пути закрыты честным «оплата не подключена», а не молча работают
   * вхолостую: начатый пробный период у бесплатного продукта — это таймер,
   * который однажды кончится и отберёт то, что ничего не стоило.
   */
  const requireBilling = (): void => {
    if (!ctx.env.BILLING_ENABLED) throw errors.billingDisabled();
  };

  /** SCREENS §9: кнопка «Попробовать». Без карты и без таймеров. */
  app.post('/api/v1/billing/trial', { preHandler: app.requireAuth }, async (request, reply) => {
    requireBilling();
    const auth = authOf(request);
    /* Длительность — из ядра, а не из переменной окружения: тем же правилом
       интерфейс обещает срок при подключении облака, и разъехаться им нельзя.
       Решение заказчика: 30 дней подключившим до 01.09.2026, дальше 14. */
    const result = await startTrial(
      ctx.db,
      auth.userId,
      trialDaysFor(ctx.now().getTime()),
      ctx.retention,
      ctx.env.BILLING_ENABLED,
      ctx.now(),
    );
    return reply.code(result.started ? 201 : 200).send({
      started: result.started,
      ...(await buildStatus(ctx, auth.userId)),
    });
  });

  /** SCREENS §9: «Отмена в один тап». Доступ до конца оплаченного периода. */
  app.post('/api/v1/billing/cancel', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    await cancelAutoRenew(ctx.db, auth.userId);
    return reply.send(await buildStatus(ctx, auth.userId));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Т-Касса
  // ───────────────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/billing/tbank/payment',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      requireBilling();
      const credentials = credentialsOf(ctx);
      if (credentials === null) throw errors.billingUnavailable();

      const parsed = paymentBody.safeParse(request.body);
      if (!parsed.success) throw errors.badRequest('bad_plan');
      const auth = authOf(request);
      await ensureSubscription(ctx.db, auth.userId);

      const orderId = newOrderId();
      const payment = await createPayment(credentials, {
        orderId,
        amountRub: amountRub(parsed.data.plan, {
          monthlyRub: ctx.env.PRICE_MONTHLY_RUB,
          yearlyMonthlyRub: ctx.env.PRICE_YEARLY_MONTHLY_RUB,
        }),
        description: parsed.data.plan === 'yearly' ? 'ЗАПИСКИ+ на год' : 'ЗАПИСКИ+ на месяц',
        successUrl: parsed.data.successUrl,
        failUrl: parsed.data.failUrl,
        notificationUrl: `${ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/billing/tbank/webhook`,
        customerKey: auth.userId,
      });

      /*
       * Кто и за что платит, знаем мы, а не банк: в уведомлении Т-Кассы нет ни
       * идентификатора человека, ни тарифа. Поэтому связь пишется здесь, до
       * оплаты, и вебхук потом находит её по номеру платежа. Отправлять свои
       * идентификаторы на чужую сторону ради удобства разбора — лишняя утечка.
       */
      await recordEvent(
        ctx,
        `init:${payment.paymentId}`,
        'payment.init',
        auth.userId,
        { plan: parsed.data.plan, orderId },
      );

      return reply.send({
        paymentId: payment.paymentId,
        status: payment.status,
        confirmationUrl: payment.paymentUrl,
      });
    },
  );

  /**
   * Уведомления Т-Кассы. Подпись лежит внутри тела (`Token`), поэтому тело
   * сначала разбирается и только потом получает доверие.
   *
   * Ответ банку — ровно текст `OK`, иначе уведомление считается недоставленным
   * и повторяется сутки. На неизвестное событие тоже отвечаем `OK`: повтор
   * ничего не изменит, а очередь ретраев засорит.
   */
  app.post('/api/v1/billing/tbank/webhook', async (request, reply) => {
    const credentials = credentialsOf(ctx);
    const check = verifyNotification({ body: request.body, credentials });

    if (!check.ok) {
      request.log.warn({ event: 'tbank_webhook_rejected', reason: check.reason }, 'подпись не сошлась');
      // not_configured — это наша ошибка конфигурации, а не чужой запрос.
      throw check.reason === 'not_configured'
        ? errors.billingUnavailable()
        : errors.badRequest(`tbank_${check.reason}`);
    }

    const notification = parseNotification(request.body);
    if (notification === null) throw errors.badRequest('tbank_bad_payload');

    const eventId = `${notification.status}:${notification.paymentId}`;
    const fresh = await recordEvent(ctx, eventId, notification.status, null, {
      orderId: notification.orderId,
      status: notification.status,
      amountRub: notification.amountRub,
      /* RebillId сознательно не пишем в журнал событий: это платёжный секрет
         (CLAUDE.md §5.4). Он уходит только в поле подписки. */
    });
    if (!fresh) return reply.type('text/plain').send('OK');

    const init = await findInit(ctx, notification.paymentId);
    if (init === null) {
      request.log.warn({ event: 'tbank_webhook_unknown_payment' }, 'платёж не наш или начат не здесь');
      return reply.type('text/plain').send('OK');
    }

    const now = ctx.now();
    if (notification.paid && notification.success) {
      await activatePaidPeriod(ctx.db, {
        userId: init.userId,
        plan: init.plan,
        provider: 'tbank',
        periodStart: now,
        periodEnd: periodEnd(init.plan, now),
        /* Автопродление обещаем только когда банк дал, чем продлевать. Самого
           списания пока нет — см. шапку services/tbank.ts. */
        autoRenew: notification.rebillId !== null,
        providerSubscriptionId: notification.rebillId,
        providerCustomerId: init.userId,
        graceDays: ctx.env.GRACE_DAYS,
      });
      return reply.type('text/plain').send('OK');
    }

    if (notification.refunded || notification.status === 'REJECTED' || notification.status === 'CANCELED') {
      // Данные не трогаем: у пользователя остаётся чтение и льготный период.
      await markPaymentFailed(ctx.db, init.userId, ctx.env.GRACE_DAYS, now);
      return reply.type('text/plain').send('OK');
    }

    return reply.type('text/plain').send('OK');
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function credentialsOf(ctx: AppContext): TbankCredentials | null {
  const terminalKey = ctx.env.TINKOFF_TERMINAL_KEY;
  const password = ctx.env.TINKOFF_PASSWORD;
  if (!terminalKey || !password) return null;
  return { terminalKey, password };
}

async function buildStatus(ctx: AppContext, userId: string): Promise<BillingStatus> {
  await ensureSubscription(ctx.db, userId);
  const entitlement = await getEntitlement(
    ctx.db,
    userId,
    ctx.retention,
    ctx.env.BILLING_ENABLED,
    ctx.now(),
  );
  return {
    /* Интерфейс прячет разговор о тарифах по этому полю: сервер — источник
       правды о том, берём ли мы сейчас деньги вообще. */
    billingEnabled: ctx.env.BILLING_ENABLED,
    plan: entitlement.plan,
    status: entitlement.status,
    canWrite: entitlement.canWrite,
    currentPeriodEnd: entitlement.currentPeriodEnd?.toISOString() ?? null,
    graceEndsAt: entitlement.graceEndsAt?.toISOString() ?? null,
    trialEndsAt: entitlement.trialEndsAt?.toISOString() ?? null,
    autoRenew: entitlement.autoRenew,
    quota: await quotaStatus(ctx.db, userId, ctx.env.QUOTA_BYTES),
    versionRetentionDays: entitlement.versionRetentionDays,
    prices: {
      monthlyRub: ctx.env.PRICE_MONTHLY_RUB,
      yearlyMonthlyRub: ctx.env.PRICE_YEARLY_MONTHLY_RUB,
    },
  };
}

/**
 * Записывает событие провайдера. Возвращает false, если такое уже было —
 * повторные уведомления норма, а не сбой.
 */
async function recordEvent(
  ctx: AppContext,
  eventId: string,
  eventType: string,
  userId: string | null,
  payload: unknown,
): Promise<boolean> {
  const result = await ctx.db.query(
    `INSERT INTO billing_events (provider, event_id, user_id, event_type, payload)
     VALUES ('tbank', $1, $2, $3, $4)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [eventId, userId, eventType, JSON.stringify(payload ?? {})],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Кто начинал этот платёж и за какой тариф. Пишется до оплаты, читается после. */
async function findInit(
  ctx: AppContext,
  paymentId: string,
): Promise<{ userId: string; plan: 'monthly' | 'yearly' } | null> {
  const result = await ctx.db.query(
    `SELECT user_id, payload FROM billing_events
      WHERE provider = 'tbank' AND event_id = $1`,
    [`init:${paymentId}`],
  );
  const row = result.rows[0] as { user_id?: string | null; payload?: unknown } | undefined;
  if (row === undefined || !row.user_id) return null;

  const payload =
    typeof row.payload === 'string'
      ? (JSON.parse(row.payload) as Record<string, unknown>)
      : ((row.payload ?? {}) as Record<string, unknown>);
  const plan = payload['plan'];
  if (plan !== 'monthly' && plan !== 'yearly') return null;

  return { userId: row.user_id, plan };
}
