import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { authOf } from '../plugins/auth.ts';
import type { BillingStatus } from '../protocol.ts';
import { PlayVerificationError } from '../services/googlePlay.ts';
import { quotaStatus } from '../services/quota.ts';
import { trialDaysFor } from '../lib/trial.ts';
import {
  activatePaidPeriod,
  cancelAutoRenew,
  ensureSubscription,
  getEntitlement,
  getSubscriptionRow,
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
import {
  createPayment as createTbankPayment,
  parseNotification as parseTbankNotification,
  verifyNotification as verifyTbankNotification,
  type TbankCredentials,
} from '../services/tbank.ts';
import { findUserById } from '../services/accounts.ts';

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
const tbankPaymentBody = paymentBody;
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
  // ───────────────────────────────────────────────────────────────────────────
  // Т-Банк (эквайринг)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Создать платёж и вернуть ссылку на платёжную форму банка.
   *
   * Заказ живёт в своей таблице, а не в метаданных платежа: `OrderId` у
   * Т-Банка не длиннее 36 знаков — туда не помещается даже один uuid с
   * тарифом, — а уведомление приносит именно его. Без записи «заказ → кто и за
   * что платит» успешная оплата не знала бы, кому включать подписку.
   */
  app.post(
    '/api/v1/billing/tbank/payment',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      requireBilling();
      const credentials = tbankCredentialsOf(ctx.env);
      if (credentials === null) throw errors.billingUnavailable();

      const parsed = tbankPaymentBody.safeParse(request.body);
      if (!parsed.success) throw errors.badRequest('bad_plan');
      const auth = authOf(request);
      await ensureSubscription(ctx.db, auth.userId);

      const rub = amountRub(parsed.data.plan, {
        monthlyRub: ctx.env.PRICE_MONTHLY_RUB,
        yearlyMonthlyRub: ctx.env.PRICE_YEARLY_MONTHLY_RUB,
      });
      /* Банк считает в копейках. Округление — до целой копейки и один раз:
         пересчёт «рубли → копейки» в двух местах однажды разойдётся. */
      const amountKop = Math.round(rub * 100);
      /*
       * `OrderId` — случайный uuid, и это не лень.
       *
       * У Т-Кассы он не длиннее 36 знаков и уезжает на чужую сторону. Ни
       * идентификатора человека, ни названия тарифа в нём быть не должно:
       * связь «кто и за что» — наше знание, а не банка. Хранится она у нас
       * (`payment_orders`) и ПИШЕТСЯ ДО перехода на оплату — уведомление
       * приносит только номер заказа, и восстановить связь после факта было
       * бы уже не из чего.
       */
      const orderId = randomUUID();
      const description = parsed.data.plan === 'yearly' ? 'ЗАПИСКИ+ на год' : 'ЗАПИСКИ+ на месяц';

      /*
       * Постоянный ключ плательщика для банка.
       *
       * Один и тот же на все платежи человека: банк привязывает к нему карту,
       * и от него зависит `RebillId`. Берём уже выданный, если он есть, —
       * новый ключ на каждый платёж означал бы нового плательщика при каждой
       * оплате и потерю привязки. Значение непрозрачно и наших идентификаторов
       * не несёт.
       */
      const known = await getSubscriptionRow(ctx.db, auth.userId);
      const customerKey = known?.provider_customer_id ?? randomUUID();

      await ctx.db.query(
        `INSERT INTO payment_orders (order_id, provider, user_id, plan, amount_kop, customer_key)
         VALUES ($1, 'tbank', $2, $3, $4, $5)`,
        [orderId, auth.userId, parsed.data.plan, amountKop, customerKey],
      );

      const email = await emailOf(ctx, auth.userId);
      if (email === null) throw errors.badRequest('email_required');

      const payment = await createTbankPayment(credentials, {
        orderId,
        amountKop,
        description,
        successUrl: parsed.data.returnUrl,
        failUrl: parsed.data.returnUrl,
        notificationUrl: `${ctx.env.PUBLIC_BASE_URL}/api/v1/billing/tbank/notification`,
        email,
        customerKey,
        /* Просим банк запомнить карту с первого же платежа: `RebillId`
           приходит только так, а без него продлевать нечем. */
        recurrent: true,
        taxation: ctx.env.TINKOFF_TAXATION,
        vat: ctx.env.TINKOFF_VAT,
      });

      await ctx.db.query(
        `UPDATE payment_orders SET payment_id = $2, status = $3, updated_at = now()
         WHERE order_id = $1`,
        [orderId, payment.paymentId, payment.status],
      );

      return reply.send({
        orderId,
        paymentId: payment.paymentId,
        status: payment.status,
        confirmationUrl: payment.paymentUrl,
      });
    },
  );

  /**
   * Уведомление о судьбе платежа.
   *
   * Подлинность доказывает только `Token` — заголовка с подписью у Т-Банка
   * нет. Ответ обязан быть строкой `OK` с кодом 200: иначе банк будет слать
   * повторы месяц.
   */
  app.post('/api/v1/billing/tbank/notification', async (request, reply) => {
    const check = verifyTbankNotification({
      body: request.body,
      password: ctx.env.TINKOFF_PASSWORD,
      terminalKey: ctx.env.TINKOFF_TERMINAL_KEY,
    });
    if (!check.ok) {
      request.log.warn({ event: 'tbank_webhook_rejected', reason: check.reason }, 'подпись не сошлась');
      throw check.reason === 'not_configured'
        ? errors.billingUnavailable()
        : errors.badRequest(`tbank_${check.reason}`);
    }

    const notification = parseTbankNotification(request.body);
    if (notification === null) throw errors.badRequest('tbank_bad_payload');

    /* Заказ знает, кому включать подписку. Нет заказа — платёж не наш. */
    const order = await ctx.db.query<{
      user_id: string;
      plan: 'monthly' | 'yearly';
      amount_kop: number;
      customer_key: string | null;
    }>(
      `SELECT user_id, plan, amount_kop, customer_key
         FROM payment_orders WHERE order_id = $1 AND provider = 'tbank'`,
      [notification.orderId],
    );
    const row = order.rows[0];
    if (row === undefined) {
      request.log.warn({ event: 'tbank_webhook_unknown_order' }, 'заказ не найден');
      return reply.type('text/plain').send('OK');
    }

    const eventId = `${notification.paymentId}:${notification.status}`;
    const fresh = await recordEvent(ctx, 'tbank', eventId, notification.status, row.user_id, request.body);
    if (!fresh) return reply.type('text/plain').send('OK');

    await ctx.db.query(
      `UPDATE payment_orders SET status = $2, payment_id = $3, updated_at = now() WHERE order_id = $1`,
      [notification.orderId, notification.status, notification.paymentId],
    );

    const now = ctx.now();
    /*
     * Деньги списаны — это `CONFIRMED`. `AUTHORIZED` означает только холд:
     * включать по нему подписку значило бы отдать платный период за деньги,
     * которых у нас ещё нет.
     */
    if (notification.success && notification.status === 'CONFIRMED') {
      /* Сумма сверяется с заказом: уведомление приходит извне, и «оплачено
         10 копеек вместо 1990 рублей» обязано остаться без подписки. */
      if (notification.amountKop !== row.amount_kop) {
        request.log.warn(
          { event: 'tbank_amount_mismatch', expected: row.amount_kop, got: notification.amountKop },
          'сумма платежа не совпала с заказом',
        );
        return reply.type('text/plain').send('OK');
      }
      await activatePaidPeriod(ctx.db, {
        userId: row.user_id,
        plan: row.plan,
        provider: 'tbank',
        periodStart: now,
        periodEnd: periodEnd(row.plan, now),
        /* Автопродления пока нет: разовый платёж и есть разовый платёж.
           `RebillId` сохраняем — с ним рекуррент включается без новой оплаты
           со стороны человека, но обещать продление до того, как оно
           написано, нельзя. */
        autoRenew: false,
        providerSubscriptionId: notification.rebillId,
        /* Ключ плательщика тот же, с которым создавали платёж: по нему банк
           узнаёт человека в следующий раз. */
        providerCustomerId: row.customer_key,
        graceDays: ctx.env.GRACE_DAYS,
      });
      return reply.type('text/plain').send('OK');
    }

    if (notification.status === 'REJECTED' || notification.status === 'REFUNDED' || notification.status === 'REVERSED') {
      // Данные не трогаем: остаётся чтение и льготный период.
      await markPaymentFailed(ctx.db, row.user_id, ctx.env.GRACE_DAYS, now);
      return reply.type('text/plain').send('OK');
    }

    return reply.type('text/plain').send('OK');
  });
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
/**
 * Настройки терминала Т-Банка, если они заданы.
 *
 * `null` — приём оплаты через банк просто не настроен. Это не отказ и не
 * поломка: ЮKassa и Google Play при этом работают как работали.
 */
function tbankCredentialsOf(env: {
  TINKOFF_TERMINAL_KEY?: string | undefined;
  TINKOFF_PASSWORD?: string | undefined;
  TINKOFF_API_BASE: string;
}): TbankCredentials | null {
  const terminalKey = env.TINKOFF_TERMINAL_KEY;
  const password = env.TINKOFF_PASSWORD;
  if (!terminalKey || !password) return null;
  return { terminalKey, password, apiBase: env.TINKOFF_API_BASE };
}

/** Почта плательщика — обязательное поле чека по 54-ФЗ. */
async function emailOf(ctx: AppContext, userId: string): Promise<string | null> {
  const user = await findUserById(ctx.db, userId);
  return user?.email ?? null;
}

async function recordEvent(
  ctx: AppContext,
  provider: 'yookassa' | 'google_play' | 'tbank',
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
