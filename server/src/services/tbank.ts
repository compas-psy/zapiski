import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Т-Банк (эквайринг): создание платежа и приём уведомлений.
 *
 * ── Решение ─────────────────────────────────────────────────────────────────
 *
 * Заказчик: «настрой процесс оплаты через ТБанк». Провайдер становится
 * ТРЕТЬИМ рядом с ЮKassa и Google Play, а не заменой: подписка написана вокруг
 * `activatePaidPeriod`, и ей всё равно, кто принёс деньги.
 *
 * ── Подпись ─────────────────────────────────────────────────────────────────
 *
 * У Т-Банка нет ни заголовка с HMAC, ни basic-авторизации: подлинность и
 * запроса, и уведомления доказывает поле `Token`. Правило одно на оба
 * направления (developer.tbank.ru/eacq/intro/developer/token):
 *
 *   1. взять параметры ВЕРХНЕГО уровня, кроме `Token` и вложенных объектов
 *      (`Receipt`, `DATA` — они в подпись не входят);
 *   2. добавить пару `Password` — пароль терминала из личного кабинета;
 *   3. отсортировать пары по имени ключа;
 *   4. склеить ЗНАЧЕНИЯ в одну строку;
 *   5. SHA-256, шестнадцатеричной строкой в нижнем регистре.
 *
 * Булевы значения едут как `true`/`false`, числа — как есть. Это важно:
 * `Success: true` в подписи участвует строкой «true», и любая своя
 * нормализация ломает сверку.
 */

/** Что кладём в подпись: только скаляры верхнего уровня. */
export type TokenParams = Record<string, string | number | boolean | null | undefined>;

/** Значение параметра так, как его видит подпись. */
function asText(value: string | number | boolean): string {
  return typeof value === 'boolean' ? String(value) : String(value);
}

/**
 * Подпись запроса или уведомления.
 *
 * `Token` и вложенные объекты отбрасываются здесь же, а не вызывающим: забыть
 * это на одной из двух сторон — самый вероятный способ получить «подпись не
 * сошлась» на живых деньгах.
 */
export function signToken(params: TokenParams, password: string): string {
  const pairs: Array<[string, string]> = [['Password', password]];
  for (const [key, value] of Object.entries(params)) {
    if (key === 'Token' || key === 'Password') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    pairs.push([key, asText(value)]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(pairs.map(([, value]) => value).join(''), 'utf8').digest('hex');
}

export type NotificationCheck =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'no_token' | 'bad_token' | 'bad_terminal' };

export interface VerifyInput {
  body: unknown;
  password: string | undefined;
  terminalKey: string | undefined;
}

/** Совпадение подписей — без утечки времени сравнения. */
function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Проверить уведомление.
 *
 * Терминал сверяется отдельно от подписи: подпись докажет, что письмо
 * подписано НАШИМ паролем, но уведомление на чужой терминал нам обрабатывать
 * нечего — это чужой платёж.
 */
export function verifyNotification(input: VerifyInput): NotificationCheck {
  if (!input.password || !input.terminalKey) return { ok: false, reason: 'not_configured' };
  if (typeof input.body !== 'object' || input.body === null) return { ok: false, reason: 'no_token' };

  const body = input.body as Record<string, unknown>;
  const token = body['Token'];
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'no_token' };
  if (body['TerminalKey'] !== input.terminalKey) return { ok: false, reason: 'bad_terminal' };

  const params: TokenParams = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params[key] = value;
    }
  }
  return sameToken(signToken(params, input.password), token) ? { ok: true } : { ok: false, reason: 'bad_token' };
}

/** Что удалось понять из уведомления. */
export interface ParsedNotification {
  orderId: string;
  paymentId: string;
  status: string;
  success: boolean;
  amountKop: number;
  /** Идентификатор для последующих списаний. Есть только у рекуррентных. */
  rebillId: string | null;
}

export function parseNotification(body: unknown): ParsedNotification | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const orderId = raw['OrderId'];
  const status = raw['Status'];
  if (typeof orderId !== 'string' || typeof status !== 'string') return null;
  return {
    orderId,
    paymentId: String(raw['PaymentId'] ?? ''),
    status,
    success: raw['Success'] === true || raw['Success'] === 'true',
    amountKop: Number(raw['Amount'] ?? 0),
    rebillId: typeof raw['RebillId'] === 'string' && raw['RebillId'] !== '' ? raw['RebillId'] : null,
  };
}

export interface TbankCredentials {
  terminalKey: string;
  password: string;
  /** Базовый адрес API. Отдельным параметром — ради тестового терминала. */
  apiBase: string;
}

export interface CreatePaymentInput {
  orderId: string;
  amountKop: number;
  description: string;
  /** Куда вернуть человека из платёжной формы. */
  successUrl: string;
  failUrl: string;
  /** Куда банк пришлёт уведомление о результате. */
  notificationUrl: string;
  /** Почта плательщика — для чека 54-ФЗ. */
  email: string;
  /** Система налогообложения и ставка НДС продавца. */
  taxation: string;
  vat: string;
}

export interface CreatedPayment {
  paymentId: string;
  status: string;
  paymentUrl: string | null;
}

/**
 * Создать платёж и получить ссылку на форму оплаты.
 *
 * Чек (54-ФЗ) отправляется всегда: терминал в России фискализирован, и без
 * `Receipt` банк отвечает отказом. Состав чека — одна позиция, наша подписка;
 * ставка НДС и система налогообложения приходят из настроек, потому что это
 * свойство ПРОДАВЦА, а не кода.
 */
export async function createPayment(
  credentials: TbankCredentials,
  input: CreatePaymentInput,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<CreatedPayment> {
  /* В подпись идут только эти поля: `Receipt` и `DATA` — вложенные. */
  const signed = {
    TerminalKey: credentials.terminalKey,
    Amount: input.amountKop,
    OrderId: input.orderId,
    Description: input.description,
    NotificationURL: input.notificationUrl,
    SuccessURL: input.successUrl,
    FailURL: input.failUrl,
  };

  const response = await fetchImpl(`${credentials.apiBase.replace(/\/$/, '')}/Init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...signed,
      Token: signToken(signed, credentials.password),
      Receipt: {
        Email: input.email,
        Taxation: input.taxation,
        Items: [
          {
            Name: input.description,
            Price: input.amountKop,
            Quantity: 1,
            Amount: input.amountKop,
            Tax: input.vat,
            PaymentMethod: 'full_prepayment',
            PaymentObject: 'service',
          },
        ],
      },
    }),
  });

  if (!response.ok) throw new Error(`Т-Банк ответил ${response.status} на создание платежа`);

  const body = (await response.json()) as Record<string, unknown>;
  /*
   * У Т-Банка отказ приезжает С КОДОМ 200 и полем `Success: false`. Проверять
   * только HTTP-статус означало бы отдать человеку пустую ссылку и сказать,
   * что всё хорошо.
   */
  if (body['Success'] !== true) {
    const code = String(body['ErrorCode'] ?? '');
    const message = String(body['Message'] ?? body['Details'] ?? 'без пояснения');
    throw new Error(`Т-Банк отказал в создании платежа (${code}): ${message}`);
  }

  return {
    paymentId: String(body['PaymentId'] ?? ''),
    status: String(body['Status'] ?? ''),
    paymentUrl: typeof body['PaymentURL'] === 'string' ? body['PaymentURL'] : null,
  };
}
