import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { signToken } from '../src/services/tbank.ts';
import { createHarness, createUser, noDatabase, type Harness, type TestUser } from './helpers/app.ts';

/**
 * Т-Касса: приём платежа и уведомления — целиком, на настоящей базе.
 *
 * Шесть правил протокола, каждое из которых ломается беззвучно и обнаруживается
 * деньгами. Проверяются они здесь, а не глазами по коду:
 *
 *   а) подпись — по значениям корневых параметров с паролем терминала;
 *   б) сперва терминал, потом токен, сравнение без утечки времени;
 *   в) оплата — только `CONFIRMED`; `AUTHORIZED` — это холд, а не деньги;
 *   г) ответ на уведомление — ровно `OK` текстом, иначе банк ретраит сутки;
 *   д) `OrderId` не несёт ни человека, ни тарифа: связь пишется у нас ДО
 *      оплаты, потому что уведомление её не приносит;
 *   е) `Init` идёт с `Recurrent`/`CustomerKey`, иначе `RebillId` не придёт.
 *
 * Пункты (а) и (е) закрыты модульно в `tbank.test.ts` — здесь проверяется то,
 * что видно только целиком: маршрут, база и подписка.
 */

const TERMINAL = 'TEST-TERMINAL';
const PASSWORD = 'test-password';

interface Order {
  orderId: string;
  amountKop: number;
  customerKey: string | null;
}

describe.skipIf(noDatabase())('Т-Касса: платёж и уведомление', () => {
  let harness: Harness;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        BILLING_ENABLED: '1',
        TINKOFF_TERMINAL_KEY: TERMINAL,
        TINKOFF_PASSWORD: PASSWORD,
        TINKOFF_API_BASE: 'https://pay.example/v2',
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await harness.close();
  });

  /** Подписать тело так, как это делает банк. */
  function signed(body: Record<string, string | number | boolean>): Record<string, unknown> {
    return { ...body, Token: signToken(body, PASSWORD) };
  }

  /** Создать платёж через ручку, подставив банку заглушку. */
  async function startPayment(
    user: TestUser,
    plan: 'monthly' | 'yearly' = 'monthly',
  ): Promise<{ order: Order; init: Record<string, unknown> }> {
    let init: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, request?: RequestInit) => {
      init = JSON.parse(String(request?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          Success: true,
          PaymentId: `pay-${String(init['OrderId'])}`,
          Status: 'NEW',
          PaymentURL: 'https://securepay.tinkoff.ru/x/abc',
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/tbank/payment',
      headers: user.authHeader,
      payload: { plan, returnUrl: 'https://zapiski.test/back' },
    });
    expect(response.statusCode).toBe(200);
    const orderId = (response.json() as { orderId: string }).orderId;

    const row = await harness.db.query<{ amount_kop: number; customer_key: string | null }>(
      'SELECT amount_kop, customer_key FROM payment_orders WHERE order_id = $1',
      [orderId],
    );
    const stored = row.rows[0];
    expect(stored, 'заказ не записан — уведомлению будет не с чем сопоставиться').toBeDefined();

    return {
      order: { orderId, amountKop: stored!.amount_kop, customerKey: stored!.customer_key },
      init,
    };
  }

  async function notify(body: Record<string, unknown>) {
    return harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/tbank/notification',
      payload: body,
    });
  }

  async function statusOf(user: TestUser): Promise<{ status: string; provider: string | null }> {
    const row = await harness.db.query<{ status: string; provider: string | null }>(
      'SELECT status, provider FROM subscriptions WHERE user_id = $1',
      [user.userId],
    );
    return row.rows[0] ?? { status: 'none', provider: null };
  }

  // ── д) Что уезжает на чужую сторону ──────────────────────────────────────

  it('OrderId не несёт ни человека, ни тарифа, а связь записана ДО оплаты', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order, init } = await startPayment(user, 'yearly');

    /* Уведомление банка приносит только номер заказа. Если бы связь «кто и за
       что» не была записана заранее, сопоставить платёж с человеком было бы
       уже не из чего — и деньги пришли бы «ничьи». */
    const stored = await harness.db.query<{ user_id: string; plan: string }>(
      'SELECT user_id, plan FROM payment_orders WHERE order_id = $1',
      [order.orderId],
    );
    expect(stored.rows[0]?.user_id).toBe(user.userId);
    expect(stored.rows[0]?.plan).toBe('yearly');

    /* А в самом номере заказа этого нет: он уезжает наружу. */
    expect(order.orderId).not.toContain(user.userId);
    expect(order.orderId.toLowerCase()).not.toContain('yearly');
    expect(order.orderId.toLowerCase()).not.toContain('monthly');
    expect(order.orderId.length).toBeLessThanOrEqual(36);

    /* Т-Касса тоже получает только номер заказа и непрозрачный ключ. */
    expect(String(init['OrderId'])).toBe(order.orderId);
    expect(String(init['CustomerKey'])).not.toContain(user.userId);
  });

  // ── е) Рекуррент ─────────────────────────────────────────────────────────

  it('ключ плательщика один и тот же на второй платёж', async () => {
    /* Новый ключ на каждую оплату означал бы нового плательщика при каждом
       платеже — и привязанную карту, которую больше не найти. */
    const user = await createUser(harness, { subscribed: false });
    const first = await startPayment(user);

    const confirmed = signed({
      TerminalKey: TERMINAL,
      OrderId: first.order.orderId,
      PaymentId: 'pay-1',
      Status: 'CONFIRMED',
      Success: true,
      Amount: first.order.amountKop,
      RebillId: '55501',
    });
    expect((await notify(confirmed)).body).toBe('OK');

    const second = await startPayment(user);
    expect(second.order.customerKey).toBe(first.order.customerKey);
    expect(String(second.init['CustomerKey'])).toBe(first.order.customerKey);
    expect(String(second.init['Recurrent'])).toBe('Y');
  });

  // ── в) Оплата — только CONFIRMED ─────────────────────────────────────────

  it('AUTHORIZED подписку не включает: это холд, а не деньги', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);

    const response = await notify(
      signed({
        TerminalKey: TERMINAL,
        OrderId: order.orderId,
        PaymentId: 'pay-auth',
        Status: 'AUTHORIZED',
        Success: true,
        Amount: order.amountKop,
      }),
    );

    /* Банку отвечаем OK — уведомление принято и понято. Но платный период не
       начинается: денег ещё нет. */
    expect(response.body).toBe('OK');
    expect((await statusOf(user)).provider).not.toBe('tbank');
  });

  it('CONFIRMED включает подписку и сохраняет RebillId', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);

    const response = await notify(
      signed({
        TerminalKey: TERMINAL,
        OrderId: order.orderId,
        PaymentId: 'pay-ok',
        Status: 'CONFIRMED',
        Success: true,
        Amount: order.amountKop,
        RebillId: '90210',
      }),
    );
    expect(response.body).toBe('OK');

    const row = await harness.db.query<{
      status: string;
      provider: string;
      provider_subscription_id: string | null;
      provider_customer_id: string | null;
    }>(
      `SELECT status, provider, provider_subscription_id, provider_customer_id
         FROM subscriptions WHERE user_id = $1`,
      [user.userId],
    );
    expect(row.rows[0]?.status).toBe('active');
    expect(row.rows[0]?.provider).toBe('tbank');
    expect(row.rows[0]?.provider_subscription_id).toBe('90210');
    expect(row.rows[0]?.provider_customer_id).toBe(order.customerKey);
  });

  it('подменённая сумма подписку не включает', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);

    const response = await notify(
      signed({
        TerminalKey: TERMINAL,
        OrderId: order.orderId,
        PaymentId: 'pay-cheap',
        Status: 'CONFIRMED',
        Success: true,
        /* Подпись сойдётся: её считает тот, кто подменил сумму. Защита здесь
           не в подписи, а в сверке с записанным у нас заказом. */
        Amount: 100,
      }),
    );
    expect(response.body).toBe('OK');
    expect((await statusOf(user)).provider).not.toBe('tbank');
  });

  // ── г) Ответ банку ───────────────────────────────────────────────────────

  it('ответ — ровно OK, текстом и с кодом 200', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);

    const response = await notify(
      signed({
        TerminalKey: TERMINAL,
        OrderId: order.orderId,
        PaymentId: 'pay-plain',
        Status: 'CONFIRMED',
        Success: true,
        Amount: order.amountKop,
      }),
    );

    /* Банк ждёт именно этих двух букв. Любой другой ответ — включая
       правильный по смыслу JSON — он считает недоставленным и повторяет
       уведомление сутки. */
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('OK');
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('на неизвестный заказ отвечаем OK, а не ошибкой', async () => {
    /* Заказ не наш — повторять его банку незачем, иначе он будет стучаться
       сутки в дверь, за которой ничего нет. */
    const response = await notify(
      signed({
        TerminalKey: TERMINAL,
        OrderId: '00000000-0000-4000-8000-000000000000',
        PaymentId: 'pay-nobody',
        Status: 'CONFIRMED',
        Success: true,
        Amount: 29900,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('OK');
  });

  // ── б) Порядок проверок ──────────────────────────────────────────────────

  it('чужой терминал отвергается ДО разбора подписи', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);

    const response = await notify({
      TerminalKey: 'CHUZHOY',
      OrderId: order.orderId,
      PaymentId: 'pay-alien',
      Status: 'CONFIRMED',
      Success: true,
      Amount: order.amountKop,
      /* Токена нет вовсе. Если бы первым проверялся он, в журнал попало бы
         «нет токена» — и чинить пошли бы не туда. */
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('tbank_bad_terminal');
  });

  it('подделанная подпись подписку не включает и OK не получает', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);

    const response = await notify({
      TerminalKey: TERMINAL,
      OrderId: order.orderId,
      PaymentId: 'pay-forged',
      Status: 'CONFIRMED',
      Success: true,
      Amount: order.amountKop,
      Token: 'f'.repeat(64),
    });

    /* Здесь `OK` было бы ошибкой: неподтверждённое уведомление мы не приняли,
       и говорить обратное нельзя. Настоящему банку это ответом не станет —
       его подпись сходится. */
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toBe('OK');
    expect((await statusOf(user)).provider).not.toBe('tbank');
  });

  it('повтор того же уведомления второй раз подписку не продлевает', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { order } = await startPayment(user);
    const body = signed({
      TerminalKey: TERMINAL,
      OrderId: order.orderId,
      PaymentId: 'pay-twice',
      Status: 'CONFIRMED',
      Success: true,
      Amount: order.amountKop,
    });

    expect((await notify(body)).body).toBe('OK');
    const after = await harness.db.query<{ current_period_end: Date }>(
      'SELECT current_period_end FROM subscriptions WHERE user_id = $1',
      [user.userId],
    );

    /* Банк повторяет уведомление, пока не получит OK, и первый ответ мог
       потеряться в пути. Второй раз период продлеваться не должен. */
    expect((await notify(body)).body).toBe('OK');
    const again = await harness.db.query<{ current_period_end: Date }>(
      'SELECT current_period_end FROM subscriptions WHERE user_id = $1',
      [user.userId],
    );
    expect(again.rows[0]?.current_period_end).toEqual(after.rows[0]?.current_period_end);
  });
});
