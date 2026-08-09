import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlayPurchase, PlayVerifier } from '../src/services/googlePlay.ts';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * Приём денег: вебхук ЮKassa и серверная валидация Google Play (ТЗ §5.5).
 *
 * Два свойства, которые нельзя терять: подпись проверяется до применения
 * (иначе подписку выдаёт кто угодно), и повтор уведомления не удваивает
 * период — провайдеры ретраят, это норма.
 */

const WEBHOOK_SECRET = 'секрет-вебхука-юкассы';

function sign(body: unknown): { payload: string; signature: string } {
  const payload = JSON.stringify(body);
  return {
    payload,
    signature: createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(payload)).digest('hex'),
  };
}

describe.skipIf(noDatabase())('вебхук ЮKassa', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ env: { YOOKASSA_WEBHOOK_SECRET: WEBHOOK_SECRET } });
  });

  afterAll(async () => {
    await harness.close();
  });

  const send = (payload: string, signature: string | undefined) =>
    harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/yookassa/webhook',
      headers: {
        'content-type': 'application/json',
        ...(signature === undefined ? {} : { 'x-yookassa-signature': signature }),
      },
      payload,
    });

  function succeeded(userId: string, plan: 'monthly' | 'yearly', paymentId: string): unknown {
    return {
      type: 'notification',
      event: 'payment.succeeded',
      object: {
        id: paymentId,
        status: 'succeeded',
        paid: true,
        amount: { value: plan === 'yearly' ? '1788.00' : '199.00', currency: 'RUB' },
        metadata: { user_id: userId, plan },
        payment_method: { id: 'pm-42', saved: true },
      },
    };
  }

  it('верная подпись включает подписку', async () => {
    const user = await createUser(harness, { subscribed: false });

    const before = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    expect((before.json() as { canWrite: boolean }).canWrite).toBe(false);

    const { payload, signature } = sign(succeeded(user.userId, 'monthly', 'pay-100'));
    const response = await send(payload, signature);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { applied?: string }).applied).toBe('activated');

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    const status = after.json() as {
      canWrite: boolean;
      plan: string;
      status: string;
      autoRenew: boolean;
      currentPeriodEnd: string;
    };
    expect(status.canWrite).toBe(true);
    expect(status.plan).toBe('monthly');
    expect(status.status).toBe('active');
    expect(status.autoRenew).toBe(true);

    const days = (new Date(status.currentPeriodEnd).getTime() - harness.ctx.now().getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('подделанная подпись отклоняется и подписку не включает', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { payload } = sign(succeeded(user.userId, 'yearly', 'pay-101'));

    const response = await send(payload, 'deadbeefdeadbeef');
    expect(response.statusCode).toBe(400);

    const status = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    expect((status.json() as { canWrite: boolean }).canWrite).toBe(false);
  });

  it('без подписи вовсе — тоже отказ', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { payload } = sign(succeeded(user.userId, 'monthly', 'pay-102'));
    expect((await send(payload, undefined)).statusCode).toBe(400);
  });

  it('повтор того же уведомления не удваивает период', async () => {
    const user = await createUser(harness, { subscribed: false });
    const { payload, signature } = sign(succeeded(user.userId, 'monthly', 'pay-103'));

    await send(payload, signature);
    const first = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    const firstEnd = (first.json() as { currentPeriodEnd: string }).currentPeriodEnd;

    const repeat = await send(payload, signature);
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { duplicate?: boolean }).duplicate).toBe(true);

    const second = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    expect((second.json() as { currentPeriodEnd: string }).currentPeriodEnd).toBe(firstEnd);
  });

  it('отменённый платёж переводит в льготный период, а не отбирает данные', async () => {
    const user = await createUser(harness);
    const canceled = sign({
      type: 'notification',
      event: 'payment.canceled',
      object: {
        id: 'pay-104',
        status: 'canceled',
        metadata: { user_id: user.userId, plan: 'monthly' },
      },
    });

    const response = await send(canceled.payload, canceled.signature);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { applied?: string }).applied).toBe('grace');

    const status = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    // Данные на месте: запись ещё доступна, пока идёт grace.
    expect((status.json() as { canWrite: boolean }).canWrite).toBe(true);
  });

  /**
   * Регрессия. Список сетей ЮKassa раньше принимался как самостоятельное
   * доказательство подлинности. Сервис стоит за nginx, значит адрес клиента
   * приходит из X-Forwarded-For — заголовка, который подделает кто угодно,
   * дотянувшийся до порта приложения. Подделанный адрес «из сети ЮKassa»
   * включал подписку без единого рубля.
   *
   * Теперь подпись обязательна всегда, а сети — только дополнительное сужение.
   */
  it('подделанный X-Forwarded-For не включает подписку', async () => {
    const guarded = await createHarness({
      env: {
        YOOKASSA_WEBHOOK_SECRET: WEBHOOK_SECRET,
        YOOKASSA_ALLOWED_CIDRS: '185.71.76.0/27',
      },
    });
    try {
      const user = await createUser(guarded, { subscribed: false });
      const { payload } = sign(succeeded(user.userId, 'yearly', 'pay-spoof-1'));

      const response = await guarded.app.inject({
        method: 'POST',
        url: '/api/v1/billing/yookassa/webhook',
        headers: {
          'content-type': 'application/json',
          // Адрес из разрешённой сети — но без подписи.
          'x-forwarded-for': '185.71.76.5',
        },
        payload,
      });
      expect(response.statusCode).toBe(400);

      const status = await guarded.app.inject({
        method: 'GET',
        url: '/api/v1/billing/status',
        headers: user.authHeader,
      });
      expect((status.json() as { canWrite: boolean }).canWrite).toBe(false);
      expect((status.json() as { plan: string }).plan).toBe('free');
    } finally {
      await guarded.close();
    }
  });

  it('одного лишь списка сетей недостаточно: без секрета вебхук выключен', async () => {
    const cidrOnly = await createHarness({
      env: { YOOKASSA_ALLOWED_CIDRS: '185.71.76.0/27' },
    });
    try {
      const user = await createUser(cidrOnly, { subscribed: false });
      const response = await cidrOnly.app.inject({
        method: 'POST',
        url: '/api/v1/billing/yookassa/webhook',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '185.71.76.5' },
        payload: JSON.stringify(succeeded(user.userId, 'yearly', 'pay-spoof-2')),
      });
      // 503 «не настроено», а не 200: непроверенное уведомление не применяется.
      expect(response.statusCode).toBe(503);

      const status = await cidrOnly.app.inject({
        method: 'GET',
        url: '/api/v1/billing/status',
        headers: user.authHeader,
      });
      expect((status.json() as { canWrite: boolean }).canWrite).toBe(false);
    } finally {
      await cidrOnly.close();
    }
  });

  it('уведомление без metadata не роняет обработчик', async () => {
    const { payload, signature } = sign({
      type: 'notification',
      event: 'payment.succeeded',
      object: { id: 'pay-105', status: 'succeeded', paid: true },
    });
    const response = await send(payload, signature);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { ignored?: boolean }).ignored).toBe(true);
  });
});

describe.skipIf(noDatabase())('валидация покупки Google Play', () => {
  let harness: Harness;
  let purchase: PlayPurchase;

  const verifier: PlayVerifier = {
    verifySubscription: async () => purchase,
  };

  beforeAll(async () => {
    harness = await createHarness({ play: verifier });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('активная покупка включает подписку', async () => {
    const user = await createUser(harness, { subscribed: false });
    const expiry = new Date(Date.now() + 30 * 86_400_000);
    purchase = {
      active: true,
      productId: 'zapiski_plus_monthly',
      expiryTime: expiry,
      startTime: new Date(),
      autoRenewing: true,
      orderId: 'GPA.3300-1111-2222-3333',
      linkedPurchaseToken: null,
    };

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/google-play/verify',
      headers: user.authHeader,
      payload: { purchaseToken: 'token-abcdef123456', productId: 'zapiski_plus_monthly' },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as { verified: boolean; active: boolean; plan: string; canWrite: boolean };
    expect(body.verified).toBe(true);
    expect(body.active).toBe(true);
    expect(body.plan).toBe('monthly');
    expect(body.canWrite).toBe(true);
  });

  it('годовой товар распознаётся как yearly', async () => {
    const user = await createUser(harness, { subscribed: false });
    purchase = {
      active: true,
      productId: 'zapiski_plus_yearly',
      expiryTime: new Date(Date.now() + 365 * 86_400_000),
      startTime: new Date(),
      autoRenewing: false,
      orderId: 'GPA.year-1',
      linkedPurchaseToken: null,
    };

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/google-play/verify',
      headers: user.authHeader,
      payload: { purchaseToken: 'token-year-000001' },
    });
    expect((response.json() as { plan: string }).plan).toBe('yearly');
  });

  it('неактивная покупка подписку не даёт', async () => {
    const user = await createUser(harness, { subscribed: false });
    purchase = {
      active: false,
      productId: 'zapiski_plus_monthly',
      expiryTime: new Date(Date.now() - 86_400_000),
      startTime: new Date(Date.now() - 40 * 86_400_000),
      autoRenewing: false,
      orderId: 'GPA.expired-1',
      linkedPurchaseToken: null,
    };

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/google-play/verify',
      headers: user.authHeader,
      payload: { purchaseToken: 'token-expired-0001' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { active: boolean; canWrite: boolean };
    expect(body.active).toBe(false);
    expect(body.canWrite).toBe(false);
  });

  it('без настроенного сервисного аккаунта — 503, а не «покупка принята»', async () => {
    const bare = await createHarness();
    try {
      const user = await createUser(bare, { subscribed: false });
      const response = await bare.app.inject({
        method: 'POST',
        url: '/api/v1/billing/google-play/verify',
        headers: user.authHeader,
        payload: { purchaseToken: 'token-abcdef123456' },
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('без токена запрос не проходит', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/google-play/verify',
      payload: { purchaseToken: 'token-abcdef123456' },
    });
    expect(response.statusCode).toBe(401);
  });
});
