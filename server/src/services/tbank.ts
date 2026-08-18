import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Т-Касса (Т-Банк, эквайринг). Единственный платёжный провайдер портфеля —
 * решение учредителя от 18.08.2026. ЮKassa и Google Play Billing из продукта
 * убраны: Google с декабря 2024 не платит российским разработчикам, а держать
 * два эквайринга на два продукта означает две сверки и два места поломки.
 *
 * ── Как здесь устроена подпись ──────────────────────────────────────────────
 *
 * У Т-Кассы нет HMAC по сырому телу. Подпись — поле `Token` внутри самого
 * тела: значения всех корневых параметров сортируются по имени ключа,
 * склеиваются вместе с паролем терминала и хешируются SHA-256. Из подписи
 * исключаются `Token`, `Receipt` и `DATA` — так требует протокол банка.
 *
 * Практическое следствие, о котором легко забыть: тело уведомления разбирается
 * ДО проверки, потому что подпись лежит внутри него. Поэтому разбор обязан
 * быть безопасным к любому мусору, а решение о доверии принимается только
 * после `verifyNotification`.
 *
 * ── Чего здесь нет ──────────────────────────────────────────────────────────
 *
 * Автосписание по `RebillId` не реализовано: первый платёж проходит с флагом
 * `Recurrent`, банк присылает `RebillId`, мы его сохраняем — но регулярное
 * списание требует отдельного планировщика, которого в MVP нет. До его
 * появления подписка продлевается повторной оплатой вручную, и интерфейс
 * обязан говорить об этом честно.
 *
 * `RebillId` — платёжный секрет: он не попадает ни в аналитику, ни в панель,
 * ни в логи (CLAUDE.md §5.4).
 */

const API_URL = 'https://securepay.tinkoff.ru/v2';

/** Поля, которые протокол исключает из подписи. */
const UNSIGNED = new Set(['Token', 'Receipt', 'DATA']);

export interface TbankCredentials {
  terminalKey: string;
  password: string;
}

/**
 * Подпись запроса и уведомления: значения корневых параметров по алфавиту
 * ключей, плюс пароль, SHA-256 в hex.
 */
export function computeToken(params: Record<string, unknown>, password: string): string {
  const signed: Record<string, string> = { Password: password };
  for (const [key, value] of Object.entries(params)) {
    if (UNSIGNED.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    signed[key] = typeof value === 'boolean' ? String(value) : String(value);
  }
  const concatenated = Object.keys(signed)
    .sort()
    .map((key) => signed[key])
    .join('');
  return createHash('sha256').update(concatenated, 'utf8').digest('hex');
}

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'no_token' | 'bad_token' | 'foreign_terminal' };

export interface VerifyInput {
  body: unknown;
  credentials: TbankCredentials | null;
}

/**
 * Проверка подлинности уведомления. Порядок проверок важен: сначала «а нам ли
 * это вообще», потом сама подпись.
 */
export function verifyNotification(input: VerifyInput): SignatureCheck {
  if (input.credentials === null) return { ok: false, reason: 'not_configured' };
  if (typeof input.body !== 'object' || input.body === null) return { ok: false, reason: 'no_token' };

  const body = input.body as Record<string, unknown>;
  const token = body['Token'];
  if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'no_token' };

  if (body['TerminalKey'] !== input.credentials.terminalKey) {
    return { ok: false, reason: 'foreign_terminal' };
  }

  const expected = computeToken(body, input.credentials.password);
  const a = Buffer.from(expected);
  const b = Buffer.from(token.toLowerCase());
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_token' };

  return { ok: true };
}

export interface ParsedNotification {
  /** `PaymentId` банка — ключ идемпотентности и связь с записью о начале оплаты. */
  paymentId: string;
  orderId: string;
  status: string;
  success: boolean;
  /** Оплачено — только `CONFIRMED`. `AUTHORIZED` при одностадийной оплате не приходит. */
  paid: boolean;
  /** Возврат: банк присылает `REFUNDED` / `PARTIAL_REFUNDED`. */
  refunded: boolean;
  amountRub: number | null;
  /** Идентификатор для будущего автосписания. Платёжный секрет. */
  rebillId: string | null;
}

export function parseNotification(raw: unknown): ParsedNotification | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;

  const paymentId = body['PaymentId'];
  const status = body['Status'];
  if (paymentId === undefined || typeof status !== 'string') return null;

  const amount = Number(body['Amount']);
  const rebill = body['RebillId'];

  return {
    paymentId: String(paymentId),
    orderId: typeof body['OrderId'] === 'string' ? body['OrderId'] : '',
    status,
    success: body['Success'] === true || body['Success'] === 'true',
    paid: status === 'CONFIRMED',
    refunded: status === 'REFUNDED' || status === 'PARTIAL_REFUNDED',
    amountRub: Number.isFinite(amount) ? Math.round(amount) / 100 : null,
    rebillId: rebill === undefined || rebill === null ? null : String(rebill),
  };
}

/** Конец периода по тарифу: месяц или год от начала. */
export function periodEnd(plan: 'monthly' | 'yearly', start: Date): Date {
  const end = new Date(start.getTime());
  if (plan === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

/** Сумма к списанию в рублях. ТЗ §5.5: 299 ₽/мес, 224 ₽/мес при годовой. */
export function amountRub(
  plan: 'monthly' | 'yearly',
  prices: { monthlyRub: number; yearlyMonthlyRub: number },
): number {
  return plan === 'yearly' ? prices.yearlyMonthlyRub * 12 : prices.monthlyRub;
}

/**
 * Номер заказа. В нём нет ни идентификатора человека, ни тарифа: связь с
 * пользователем хранится у нас, а не ездит по чужой стороне. Длина — с запасом
 * под ограничение банка в 36 символов.
 */
export function newOrderId(): string {
  return `z${randomBytes(12).toString('hex')}`;
}

export interface CreatePaymentInput {
  orderId: string;
  amountRub: number;
  description: string;
  successUrl: string;
  failUrl: string;
  notificationUrl: string | null;
  /** Ключ покупателя для будущего автосписания. */
  customerKey: string;
}

export interface CreatedPayment {
  paymentId: string;
  status: string;
  paymentUrl: string | null;
}

export async function createPayment(
  credentials: TbankCredentials,
  input: CreatePaymentInput,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<CreatedPayment> {
  const payload: Record<string, unknown> = {
    TerminalKey: credentials.terminalKey,
    Amount: Math.round(input.amountRub * 100),
    OrderId: input.orderId,
    Description: input.description,
    SuccessURL: input.successUrl,
    FailURL: input.failUrl,
    CustomerKey: input.customerKey,
    /* Первый платёж помечается как родительский для будущих списаний. Само
       списание пока не выполняется — см. шапку модуля. */
    Recurrent: 'Y',
  };
  if (input.notificationUrl !== null) payload['NotificationURL'] = input.notificationUrl;
  payload['Token'] = computeToken(payload, credentials.password);

  const response = await fetchImpl(`${API_URL}/Init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) throw new Error(`Т-Касса вернула ${response.status} на Init`);

  const body = (await response.json()) as {
    Success?: unknown;
    PaymentId?: unknown;
    Status?: unknown;
    PaymentURL?: unknown;
    Message?: unknown;
    Details?: unknown;
  };

  if (body.Success !== true) {
    /* Сообщение банка не выносим наружу дословно: в нём бывают детали
       терминала. В лог — да, пользователю — нет. */
    throw new Error(
      `Т-Касса отказала: ${typeof body.Message === 'string' ? body.Message : 'без причины'}`,
    );
  }

  return {
    paymentId: body.PaymentId === undefined ? '' : String(body.PaymentId),
    status: typeof body.Status === 'string' ? body.Status : '',
    paymentUrl: typeof body.PaymentURL === 'string' ? body.PaymentURL : null,
  };
}
