/**
 * Т-Банк: подпись, разбор уведомления и создание платежа.
 *
 * ── Почему проверки именно такие ────────────────────────────────────────────
 *
 * У Т-Банка нет ни заголовка с HMAC, ни basic-авторизации: подлинность и
 * запроса, и уведомления доказывает ОДНО поле `Token`. Значит цена ошибки в
 * подписи — либо «банк не принимает платежи вовсе», либо «чужой запрос включил
 * подписку». Поэтому образец здесь взят из документации банка дословно, а не
 * посчитан этим же кодом: тест, который сверяет функцию с самой собой, доказал
 * бы только её самосогласованность.
 */
import { describe, expect, it } from 'vitest';

import {
  createPayment,
  parseNotification,
  signToken,
  verifyNotification,
} from '../src/services/tbank.ts';

/* Пример из developer.tbank.ru/eacq/intro/developer/token. */
const SAMPLE = {
  TerminalKey: 'MerchantTerminalKey',
  Amount: 19200,
  OrderId: '00000',
  Description: 'Подарочная карта на 1000 рублей',
};
const SAMPLE_PASSWORD = '11111111111111';

describe('подпись запроса', () => {
  it('считается по документации банка: значения по алфавиту ключей + пароль', () => {
    /* Порядок ключей: Amount, Description, OrderId, Password, TerminalKey.
       Значение — из примера банка, а не посчитано этим же кодом. */
    const expected = '72dd466f8ace0a37a1f740ce5fb78101712bc0665d91a8108c7c8a0ccd426db2';
    expect(signToken(SAMPLE, SAMPLE_PASSWORD)).toBe(expected);
  });

  it('порядок полей в объекте на подпись не влияет', () => {
    const shuffled = {
      Description: SAMPLE.Description,
      TerminalKey: SAMPLE.TerminalKey,
      OrderId: SAMPLE.OrderId,
      Amount: SAMPLE.Amount,
    };
    expect(signToken(shuffled, SAMPLE_PASSWORD)).toBe(signToken(SAMPLE, SAMPLE_PASSWORD));
  });

  it('вложенные объекты в подпись не входят — так требует банк', () => {
    const withNested = { ...SAMPLE, Receipt: { Email: 'a@b.c' }, DATA: { plan: 'monthly' } };
    expect(signToken(withNested as never, SAMPLE_PASSWORD)).toBe(
      signToken(SAMPLE, SAMPLE_PASSWORD),
    );
  });

  it('булево едет строкой, а не единицей и нулём', () => {
    expect(signToken({ Success: true }, 'p')).toBe(signToken({ Success: 'true' }, 'p'));
    expect(signToken({ Success: true }, 'p')).not.toBe(signToken({ Success: 1 }, 'p'));
  });
});

describe('проверка уведомления', () => {
  const password = 'secret-password';
  const terminalKey = 'TERMINAL';
  const body = {
    TerminalKey: terminalKey,
    OrderId: 'order-1',
    Success: true,
    Status: 'CONFIRMED',
    PaymentId: '900001',
    ErrorCode: '0',
    Amount: 19900,
    RebillId: '5555',
  };
  const signed = { ...body, Token: signToken(body, password) };

  it('своё уведомление принимается', () => {
    expect(verifyNotification({ body: signed, password, terminalKey })).toEqual({ ok: true });
  });

  it('подделанная сумма ломает подпись — иначе подписку выдал бы кто угодно', () => {
    const tampered = { ...signed, Amount: 1 };
    expect(verifyNotification({ body: tampered, password, terminalKey })).toEqual({
      ok: false,
      reason: 'bad_token',
    });
  });

  it('чужой терминал не наш платёж, даже с верной подписью', () => {
    expect(verifyNotification({ body: signed, password, terminalKey: 'OTHER' })).toEqual({
      ok: false,
      reason: 'bad_terminal',
    });
  });

  it('без токена — отказ, а не «наверное, свои»', () => {
    const { Token: _drop, ...naked } = signed;
    expect(verifyNotification({ body: naked, password, terminalKey })).toEqual({
      ok: false,
      reason: 'no_token',
    });
  });

  it('терминал не настроен — это наша ошибка настройки, а не чужой запрос', () => {
    expect(verifyNotification({ body: signed, password: undefined, terminalKey })).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  it('разбор достаёт то, по чему принимается решение', () => {
    expect(parseNotification(signed)).toEqual({
      orderId: 'order-1',
      paymentId: '900001',
      status: 'CONFIRMED',
      success: true,
      amountKop: 19900,
      rebillId: '5555',
    });
  });

  it('«Success» строкой банк тоже присылает', () => {
    expect(parseNotification({ ...signed, Success: 'true' })?.success).toBe(true);
  });
});

describe('создание платежа', () => {
  const credentials = { terminalKey: 'TERMINAL', password: 'pw', apiBase: 'https://pay.example/v2' };
  const input = {
    orderId: 'order-1',
    amountKop: 19900,
    description: 'ЗАПИСКИ+ на месяц',
    successUrl: 'https://zapiski.example/back',
    failUrl: 'https://zapiski.example/back',
    notificationUrl: 'https://zapiski.example/api/v1/billing/tbank/notification',
    email: 'marina@ya.ru',
    customerKey: 'cust-0001',
    recurrent: true,
    taxation: 'usn_income',
    vat: 'none',
  };

  it('уходит подписанный Init с чеком, а обратно приезжает ссылка на форму', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const payment = await createPayment(credentials, input, async (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          Success: true,
          PaymentId: '900001',
          Status: 'NEW',
          PaymentURL: 'https://securepay.tinkoff.ru/x/abc',
        }),
        { status: 200 },
      );
    });

    expect(seen[0]?.url).toBe('https://pay.example/v2/Init');
    const body = seen[0]?.body ?? {};
    expect(body['Amount']).toBe(19900);
    /* Подпись считается по тем же полям, что уехали, — без чека и без DATA. */
    expect(body['Token']).toBe(
      signToken(
        {
          TerminalKey: 'TERMINAL',
          Amount: 19900,
          OrderId: 'order-1',
          Description: 'ЗАПИСКИ+ на месяц',
          NotificationURL: input.notificationUrl,
          SuccessURL: input.successUrl,
          FailURL: input.failUrl,
          CustomerKey: 'cust-0001',
          Recurrent: 'Y',
        },
        'pw',
      ),
    );
    /* Чек обязателен: без него фискализированный терминал отвечает отказом. */
    const receipt = body['Receipt'] as { Email?: string; Items?: Array<{ Amount?: number }> };
    expect(receipt.Email).toBe('marina@ya.ru');
    expect(receipt.Items?.[0]?.Amount).toBe(19900);

    expect(payment).toEqual({
      paymentId: '900001',
      status: 'NEW',
      paymentUrl: 'https://securepay.tinkoff.ru/x/abc',
    });
  });

  /**
   * Без `Recurrent: 'Y'` и `CustomerKey` банк не пришлёт `RebillId`.
   *
   * Пропуск этих двух полей ничего не ломает СЕГОДНЯ: платёж проходит, деньги
   * приходят, подписка включается. Обнаруживается он через месяц — тем, что
   * продлевать нечем. Поэтому проверяется здесь, а не в проде.
   */
  it('Init просит банк запомнить карту и знает плательщика', async () => {
    let sent: Record<string, unknown> = {};
    await createPayment(credentials, input, async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ Success: true, PaymentId: '1', Status: 'NEW' }), {
        status: 200,
      });
    });
    expect(sent['Recurrent']).toBe('Y');
    expect(sent['CustomerKey']).toBe('cust-0001');
  });

  it('без рекуррента поле Recurrent не уезжает вовсе', async () => {
    /* Пустая строка в этом поле банку не годится, а в подпись она попала бы
       наравне со значением — и подпись разошлась бы с той, что считает банк. */
    let sent: Record<string, unknown> = {};
    await createPayment(credentials, { ...input, recurrent: false }, async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ Success: true, PaymentId: '1', Status: 'NEW' }), {
        status: 200,
      });
    });
    expect('Recurrent' in sent).toBe(false);
    expect(sent['Token']).toBe(
      signToken(
        {
          TerminalKey: 'TERMINAL',
          Amount: 19900,
          OrderId: 'order-1',
          Description: 'ЗАПИСКИ+ на месяц',
          NotificationURL: input.notificationUrl,
          SuccessURL: input.successUrl,
          FailURL: input.failUrl,
          CustomerKey: 'cust-0001',
        },
        'pw',
      ),
    );
  });

  it('CustomerKey не длиннее того, что принимает банк', () => {
    /* Ограничение Т-Кассы — 36 знаков. uuid укладывается ровно в них, но
       правило должно быть проверено, а не удержано в голове. */
    expect(input.customerKey.length).toBeLessThanOrEqual(36);
  });

  /**
   * Отказ у Т-Банка приезжает С КОДОМ 200.
   *
   * Проверять только HTTP-статус означало бы отдать человеку пустую ссылку и
   * сказать, что всё хорошо.
   */
  it('отказ банка — это отказ, даже если ответ 200', async () => {
    await expect(
      createPayment(credentials, input, async () =>
        new Response(
          JSON.stringify({ Success: false, ErrorCode: '9999', Message: 'Неверные параметры' }),
          { status: 200 },
        ),
      ),
    ).rejects.toThrow(/9999/);
  });
});
