import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { computeToken } from '../src/services/tbank.ts';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Приём денег: уведомления Т-Кассы (ТЗ §5.5).
 *
 * Три свойства, которые нельзя терять:
 *  1. подпись проверяется до применения — иначе подписку выдаёт кто угодно;
 *  2. повтор уведомления не удваивает период — банк ретраит, это норма;
 *  3. неудачный платёж переводит в льготный период, но не отбирает данные.
 *
 * Отдельно проверяется то, чего не было у прошлого провайдера: в уведомлении
 * Т-Кассы нет ни идентификатора человека, ни тарифа — связь пишется нами до
 * оплаты. Уведомление о платеже, который начинали не мы, ничего не включает.
 */

const TERMINAL_KEY = 'TESTTERMINAL0001';
const PASSWORD = 'пароль-терминала-для-теста';

/** Ответ банку — ровно `OK`, иначе уведомление считается недоставленным. */
const OK = 'OK';

function signed(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, Token: computeToken(body, PASSWORD) };
}

function notification(
  paymentId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return signed({
    TerminalKey: TERMINAL_KEY,
    OrderId: `order-${paymentId}`,
    Success: status === 'CONFIRMED',
    Status: status,
    PaymentId: paymentId,
    Amount: 29900,
    ...extra,
  });
}

describe.skipIf(noDatabase())('уведомления Т-Кассы', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      env: {
        TINKOFF_TERMINAL_KEY: TERMINAL_KEY,
        TINKOFF_PASSWORD: PASSWORD,
        BILLING_ENABLED: '1',
      },
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  const send = (body: unknown) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/tbank/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  /** Запись о начале оплаты — та самая связь «кто и за что», см. routes/billing.ts. */
  async function startedPayment(
    userId: string,
    plan: 'monthly' | 'yearly',
    paymentId: string,
  ): Promise<void> {
    await harness.db.query(
      `INSERT INTO billing_events (provider, event_id, user_id, event_type, payload)
       VALUES ('tbank', $1, $2, 'payment.init', $3)`,
      [`init:${paymentId}`, userId, JSON.stringify({ plan, orderId: `order-${paymentId}` })],
    );
  }

  const statusOf = async (user: { authHeader: { authorization: string } }) =>
    (
      await harness.app.inject({
        method: 'GET',
        url: '/api/v1/billing/status',
        headers: user.authHeader,
      })
    ).json() as {
      canWrite: boolean;
      plan: string;
      status: string;
      autoRenew: boolean;
      currentPeriodEnd: string;
    };

  it('верная подпись включает подписку', async () => {
    const user = await createUser(harness, { subscribed: false });
    await startedPayment(user.userId, 'monthly', 'pay-100');

    expect((await statusOf(user)).canWrite).toBe(false);

    const response = await send(notification('pay-100', 'CONFIRMED', { RebillId: 987654321 }));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(OK);

    const status = await statusOf(user);
    expect(status.canWrite).toBe(true);
    expect(status.plan).toBe('monthly');
    expect(status.status).toBe('active');
    expect(status.autoRenew).toBe(true);

    const days =
      (new Date(status.currentPeriodEnd).getTime() - harness.ctx.now().getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('подделанная подпись отклоняется и подписку не включает', async () => {
    const user = await createUser(harness, { subscribed: false });
    await startedPayment(user.userId, 'yearly', 'pay-101');

    const body = notification('pay-101', 'CONFIRMED');
    const response = await send({ ...body, Token: 'deadbeef'.repeat(8) });
    expect(response.statusCode).toBe(400);

    expect((await statusOf(user)).canWrite).toBe(false);
  });

  it('без подписи вовсе — тоже отказ', async () => {
    const user = await createUser(harness, { subscribed: false });
    await startedPayment(user.userId, 'monthly', 'pay-102');

    const { Token: _drop, ...unsigned } = notification('pay-102', 'CONFIRMED');
    expect((await send(unsigned)).statusCode).toBe(400);
    expect((await statusOf(user)).canWrite).toBe(false);
  });

  it('уведомление с чужого терминала не принимается', async () => {
    const user = await createUser(harness, { subscribed: false });
    await startedPayment(user.userId, 'monthly', 'pay-103');

    const foreign = signed({
      TerminalKey: 'FOREIGNTERMINAL',
      OrderId: 'order-pay-103',
      Success: true,
      Status: 'CONFIRMED',
      PaymentId: 'pay-103',
      Amount: 29900,
    });
    const response = await send(foreign);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'tbank_foreign_terminal' } });
    expect((await statusOf(user)).canWrite).toBe(false);
  });

  it('повтор того же уведомления не удваивает период', async () => {
    const user = await createUser(harness, { subscribed: false });
    await startedPayment(user.userId, 'monthly', 'pay-104');

    const body = notification('pay-104', 'CONFIRMED', { RebillId: 111 });
    await send(body);
    const firstEnd = (await statusOf(user)).currentPeriodEnd;

    const repeat = await send(body);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.body).toBe(OK);

    expect((await statusOf(user)).currentPeriodEnd).toBe(firstEnd);
  });

  it('отклонённый платёж переводит в льготный период, а не отбирает данные', async () => {
    const user = await createUser(harness);
    await startedPayment(user.userId, 'monthly', 'pay-105');

    const response = await send(notification('pay-105', 'REJECTED'));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(OK);

    // Данные на месте: запись ещё доступна, пока идёт grace.
    expect((await statusOf(user)).canWrite).toBe(true);
  });

  /**
   * Регрессия по смыслу, унаследованная от прошлого провайдера: подлинность
   * уведомления обязана доказываться подписью, и ничем иным. У Т-Кассы нет
   * заголовка подписи вовсе — подпись лежит в теле, — поэтому проверяем, что
   * уведомление о платеже, которого мы не начинали, не включает подписку даже
   * с верной подписью терминала.
   */
  it('платёж, начатый не нами, ничего не включает', async () => {
    const user = await createUser(harness, { subscribed: false });
    const response = await send(notification('pay-неизвестный', 'CONFIRMED', { RebillId: 222 }));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(OK);
    expect((await statusOf(user)).canWrite).toBe(false);
  });

  it('без ключей терминала вебхук отвечает 503 и ничего не применяет', async () => {
    const bare = await createHarness({ env: { BILLING_ENABLED: '1' } });
    try {
      const user = await createUser(bare, { subscribed: false });
      const response = await bare.app.inject({
        method: 'POST',
        url: '/api/v1/billing/tbank/webhook',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(notification('pay-200', 'CONFIRMED')),
      });
      expect(response.statusCode).toBe(503);

      const status = await bare.app.inject({
        method: 'GET',
        url: '/api/v1/billing/status',
        headers: user.authHeader,
      });
      expect((status.json() as { canWrite: boolean }).canWrite).toBe(false);
    } finally {
      await bare.close();
    }
  });
});
