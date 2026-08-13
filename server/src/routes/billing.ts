import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { authOf } from '../plugins/auth.ts';
import type { BillingStatus } from '../protocol.ts';
import { PlayVerificationError } from '../services/googlePlay.ts';
import { quotaStatus } from '../services/quota.ts';
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
  parseNotification,
  periodEnd,
  verifyNotification,
} from '../services/yookassa.ts';

/**
 * Подписка (ТЗ §5.5). 199 ₽/мес, 149 ₽/мес при годовой оплате.
 *
 * Главное правило, которое этот модуль обязан сохранять: **истечение подписки
 * не блокирует данные**. Здесь считается только `canWrite`; ни один эндпоинт
 * чтения в облаке на него не смотрит. SCREENS §9 прямо запрещает «блокировку
 * доступа к уже созданным заметкам».
 */

const planSchema = z.enum(['monthly', 'yearly']);
const paymentBody = z.object({ plan: planSchema, returnUrl: z.string().url() });
const playBody = z.object({
  purchaseToken: z.string().min(8).max(4096),
  productId: z.string().min(1).max(200).optional(),
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

  /** SCREENS §9: кнопка «Попробовать 14 дней». Без карты и без таймеров. */
  app.post('/api/v1/billing/trial', { preHandler: app.requireAuth }, async (request, reply) => {
    requireBilling();
    const auth = authOf(request);
    const result = await startTrial(
      ctx.db,
      auth.userId,
      ctx.env.TRIAL_DAYS,
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
  // ЮKassa
  // ───────────────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/billing/yookassa/payment',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      requireBilling();
      const shopId = ctx.env.YOOKASSA_SHOP_ID;
      const secretKey = ctx.env.YOOKASSA_SECRET_KEY;
      if (!shopId || !secretKey) throw errors.billingUnavailable();

      const parsed = paymentBody.safeParse(request.body);
      if (!parsed.success) throw errors.badRequest('bad_plan');
      const auth = authOf(request);
      await ensureSubscription(ctx.db, auth.userId);

      const payment = await createPayment(
        { shopId, secretKey },
        {
          userId: auth.userId,
          plan: parsed.data.plan,
          amountRub: amountRub(parsed.data.plan, {
            monthlyRub: ctx.env.PRICE_MONTHLY_RUB,
            yearlyMonthlyRub: ctx.env.PRICE_YEARLY_MONTHLY_RUB,
          }),
          description: parsed.data.plan === 'yearly' ? 'ЗАПИСКИ+ на год' : 'ЗАПИСКИ+ на месяц',
          returnUrl: parsed.data.returnUrl,
          idempotenceKey: randomUUID(),
        },
      );

      return reply.send({
        paymentId: payment.id,
        status: payment.status,
        confirmationUrl: payment.confirmationUrl,
      });
    },
  );

  /**
   * Уведомления ЮKassa. Аутентичность проверяется до разбора тела: HMAC по
   * сырым байтам и/или список сетей отправителя.
   *
   * Ответ всегда 200 после успешной проверки, даже на неизвестное событие, —
   * иначе ЮKassa будет ретраить сутки. Проваленная проверка подписи — 400.
   */
  app.post('/api/v1/billing/yookassa/webhook', async (request, reply) => {
    const raw = request.rawBody ?? Buffer.alloc(0);
    const check = verifyNotification({
      rawBody: raw,
      signatureHeader: headerOf(request, 'x-yookassa-signature') ?? headerOf(request, 'signature'),
      remoteAddress: request.ip,
      secret: ctx.env.YOOKASSA_WEBHOOK_SECRET,
      allowedCidrs: ctx.env.yookassaAllowedCidrs,
    });

    if (!check.ok) {
      request.log.warn({ event: 'yookassa_webhook_rejected', reason: check.reason }, 'подпись не сошлась');
      // not_configured — это наша ошибка конфигурации, а не чужой запрос.
      throw check.reason === 'not_configured'
        ? errors.billingUnavailable()
        : errors.badRequest(`yookassa_${check.reason}`);
    }

    const notification = parseNotification(request.body);
    if (notification === null) throw errors.badRequest('yookassa_bad_payload');

    const eventId = `${notification.event}:${notification.objectId}`;
    const fresh = await recordEvent(ctx, 'yookassa', eventId, notification.event, notification.userId, request.body);
    if (!fresh) return reply.send({ ok: true, duplicate: true });

    if (notification.userId === null || notification.plan === null) {
      request.log.warn({ event: 'yookassa_webhook_no_metadata' }, 'в уведомлении нет user_id/plan');
      return reply.send({ ok: true, ignored: true });
    }

    const now = ctx.now();
    if (notification.event === 'payment.succeeded' && notification.paid) {
      await activatePaidPeriod(ctx.db, {
        userId: notification.userId,
        plan: notification.plan,
        provider: 'yookassa',
        periodStart: now,
        periodEnd: periodEnd(notification.plan, now),
        autoRenew: notification.paymentMethodId !== null,
        providerSubscriptionId: notification.paymentMethodId,
        providerCustomerId: null,
        graceDays: ctx.env.GRACE_DAYS,
      });
      return reply.send({ ok: true, applied: 'activated' });
    }

    if (notification.event === 'payment.canceled' || notification.event === 'refund.succeeded') {
      // Данные не трогаем: у пользователя остаётся чтение и льготный период.
      await markPaymentFailed(ctx.db, notification.userId, ctx.env.GRACE_DAYS, now);
      return reply.send({ ok: true, applied: 'grace' });
    }

    return reply.send({ ok: true, ignored: true });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Google Play Billing
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Серверная валидация покупки. Результату проверки на устройстве не
   * доверяем: сервер сам спрашивает Google Play Developer API.
   */
  app.post(
    '/api/v1/billing/google-play/verify',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      requireBilling();
      const verifier = ctx.play;
      if (verifier === null) throw errors.billingUnavailable();

      const parsed = playBody.safeParse(request.body);
      if (!parsed.success) throw errors.badRequest('bad_purchase_token');
      const auth = authOf(request);

      let purchase;
      try {
        purchase = await verifier.verifySubscription(parsed.data.purchaseToken);
      } catch (error) {
        if (error instanceof PlayVerificationError) {
          request.log.warn(
            { event: 'play_verify_failed', stage: error.stage },
            'Google Play не подтвердил покупку',
          );
          throw errors.badRequest(`play_${error.stage}_failed`);
        }
        throw error;
      }

      const eventId = purchase.orderId ?? `token:${parsed.data.purchaseToken.slice(0, 64)}`;
      await recordEvent(ctx, 'google_play', eventId, 'subscription.verified', auth.userId, {
        productId: purchase.productId,
        expiryTime: purchase.expiryTime.toISOString(),
        active: purchase.active,
      });

      if (!purchase.active) {
        return reply.code(200).send({
          verified: true,
          active: false,
          ...(await buildStatus(ctx, auth.userId)),
        });
      }

      const plan = planOfProduct(purchase.productId);
      await activatePaidPeriod(ctx.db, {
        userId: auth.userId,
        plan,
        provider: 'google_play',
        periodStart: purchase.startTime,
        periodEnd: purchase.expiryTime,
        autoRenew: purchase.autoRenewing,
        providerSubscriptionId: parsed.data.purchaseToken,
        providerCustomerId: null,
        graceDays: ctx.env.GRACE_DAYS,
      });

      return reply.send({
        verified: true,
        active: true,
        ...(await buildStatus(ctx, auth.userId)),
      });
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────

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
  provider: 'yookassa' | 'google_play',
  eventId: string,
  eventType: string,
  userId: string | null,
  payload: unknown,
): Promise<boolean> {
  const result = await ctx.db.query(
    `INSERT INTO billing_events (provider, event_id, user_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [provider, eventId, userId, eventType, JSON.stringify(payload ?? {})],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Годовой тариф опознаётся по идентификатору товара в Play Console. */
function planOfProduct(productId: string): 'monthly' | 'yearly' {
  return /year|annual|god|year(ly)?/i.test(productId) ? 'yearly' : 'monthly';
}

function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}
