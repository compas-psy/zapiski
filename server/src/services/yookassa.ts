import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';

/**
 * ЮKassa: приём уведомлений и разбор их содержимого (ТЗ §5.5).
 *
 * Подлинность проверяется подписью — и только ею:
 *
 * 1. `YOOKASSA_WEBHOOK_SECRET` — HMAC-SHA256 по сырому телу запроса,
 *    сравнение с заголовком, timing-safe. **Обязателен.** Без него вебхук
 *    отвечает 503 и ничего не применяет.
 * 2. `YOOKASSA_ALLOWED_CIDRS` — необязательное дополнительное сужение по
 *    сети отправителя. Само по себе оно ничего не подтверждает и никогда не
 *    заменяет подпись.
 *
 * Почему адрес не может быть единственным доказательством: сервис стоит за
 * nginx, то есть адрес клиента приходит из `X-Forwarded-For`. Этот заголовок
 * может подделать кто угодно, кто дотянется до порта приложения, — и подделка
 * IP «из сетей ЮKassa» выдала бы подписку без единого рубля. Список сетей
 * полезен как второй забор, но забором первым он быть не может.
 *
 * Само тело уведомления не содержит данных заметок и в квоту не попадает.
 */

export const SIGNATURE_HEADERS = ['x-yookassa-signature', 'signature'] as const;

export type SignatureCheck =
  | { ok: true; via: 'hmac' | 'hmac+cidr' }
  | { ok: false; reason: 'no_signature' | 'bad_signature' | 'ip_not_allowed' | 'not_configured' };

export interface VerifyInput {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  remoteAddress: string | undefined;
  secret: string | undefined;
  allowedCidrs: string[];
}

export function verifyNotification(input: VerifyInput): SignatureCheck {
  const secret = input.secret !== undefined && input.secret.length > 0 ? input.secret : null;

  // Подпись обязательна всегда. Список сетей её не заменяет: адрес приходит из
  // X-Forwarded-For и потому подделываем.
  if (secret === null) return { ok: false, reason: 'not_configured' };

  if (input.signatureHeader === undefined || input.signatureHeader.length === 0) {
    return { ok: false, reason: 'no_signature' };
  }
  if (!signatureMatches(input.rawBody, secret, input.signatureHeader)) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (input.allowedCidrs.length > 0) {
    if (input.remoteAddress === undefined || !ipInAnyCidr(input.remoteAddress, input.allowedCidrs)) {
      return { ok: false, reason: 'ip_not_allowed' };
    }
    return { ok: true, via: 'hmac+cidr' };
  }

  return { ok: true, via: 'hmac' };
}

/**
 * Подпись принимается и как hex, и как base64 — форматы у разных интеграций
 * различаются, а требовать один означает ложные отказы на боевом трафике.
 */
function signatureMatches(rawBody: Buffer, secret: string, header: string): boolean {
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  const candidate = header.trim().replace(/^v1[=\s]/i, '');
  for (const encoding of ['hex', 'base64'] as const) {
    const expected = digest.toString(encoding);
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function ipInAnyCidr(ip: string, cidrs: string[]): boolean {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return cidrs.some((cidr) => ipInCidr(normalized, cidr));
}

/** Поддерживает IPv4-CIDR; для IPv6 сравнивает адреса как есть. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [network, bitsRaw] = cidr.split('/');
  if (network === undefined) return false;
  if (bitsRaw === undefined) return ip === network;

  if (!isIPv4(ip) || !isIPv4(network)) {
    return ip === network;
  }
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;

  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (toUint32(ip) & mask) === (toUint32(network) & mask);
}

function toUint32(ip: string): number {
  const parts = ip.split('.').map(Number);
  return (
    (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>>
    0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Разбор уведомления
// ─────────────────────────────────────────────────────────────────────────────

export type YookassaEvent =
  | 'payment.succeeded'
  | 'payment.canceled'
  | 'payment.waiting_for_capture'
  | 'refund.succeeded'
  | 'subscription.canceled';

export interface ParsedNotification {
  event: string;
  /** Идентификатор объекта — ключ идемпотентности. */
  objectId: string;
  status: string;
  /** user_id и plan приходят в metadata, которую мы сами кладём при оплате. */
  userId: string | null;
  plan: 'monthly' | 'yearly' | null;
  paid: boolean;
  amountRub: number | null;
  /** id сохранённого способа оплаты — для автопродления. */
  paymentMethodId: string | null;
}

export function parseNotification(raw: unknown): ParsedNotification | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as { event?: unknown; object?: unknown };
  if (typeof body.event !== 'string') return null;
  if (typeof body.object !== 'object' || body.object === null) return null;

  const object = body.object as {
    id?: unknown;
    status?: unknown;
    paid?: unknown;
    metadata?: unknown;
    amount?: unknown;
    payment_method?: unknown;
  };

  const metadata =
    typeof object.metadata === 'object' && object.metadata !== null
      ? (object.metadata as Record<string, unknown>)
      : {};

  const planRaw = metadata['plan'];
  const plan = planRaw === 'monthly' || planRaw === 'yearly' ? planRaw : null;

  const amount =
    typeof object.amount === 'object' && object.amount !== null
      ? Number((object.amount as { value?: unknown }).value)
      : NaN;

  const paymentMethod =
    typeof object.payment_method === 'object' && object.payment_method !== null
      ? (object.payment_method as { id?: unknown; saved?: unknown })
      : null;

  return {
    event: body.event,
    objectId: typeof object.id === 'string' ? object.id : '',
    status: typeof object.status === 'string' ? object.status : '',
    userId: typeof metadata['user_id'] === 'string' ? (metadata['user_id'] as string) : null,
    plan,
    paid: object.paid === true || object.status === 'succeeded',
    amountRub: Number.isFinite(amount) ? amount : null,
    paymentMethodId:
      paymentMethod !== null && typeof paymentMethod.id === 'string' ? paymentMethod.id : null,
  };
}

/** Конец периода по тарифу: месяц или год от начала. */
export function periodEnd(plan: 'monthly' | 'yearly', start: Date): Date {
  const end = new Date(start.getTime());
  if (plan === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

/** Сумма к списанию в рублях. ТЗ §5.5: 199 ₽/мес, 149 ₽/мес при годовой. */
export function amountRub(
  plan: 'monthly' | 'yearly',
  prices: { monthlyRub: number; yearlyMonthlyRub: number },
): number {
  return plan === 'yearly' ? prices.yearlyMonthlyRub * 12 : prices.monthlyRub;
}

// ─────────────────────────────────────────────────────────────────────────────
// Создание платежа
// ─────────────────────────────────────────────────────────────────────────────

const PAYMENTS_URL = 'https://api.yookassa.ru/v3/payments';

export interface YookassaCredentials {
  shopId: string;
  secretKey: string;
}

export interface CreatePaymentInput {
  userId: string;
  plan: 'monthly' | 'yearly';
  amountRub: number;
  description: string;
  returnUrl: string;
  /** Ключ идемпотентности: повтор с тем же ключом не создаёт второй платёж. */
  idempotenceKey: string;
}

export interface CreatedPayment {
  id: string;
  status: string;
  confirmationUrl: string | null;
}

export async function createPayment(
  credentials: YookassaCredentials,
  input: CreatePaymentInput,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<CreatedPayment> {
  const auth = Buffer.from(`${credentials.shopId}:${credentials.secretKey}`).toString('base64');
  const response = await fetchImpl(PAYMENTS_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'idempotence-key': input.idempotenceKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount: { value: input.amountRub.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: input.returnUrl },
      description: input.description,
      // Автопродление: сохраняем способ оплаты, отмена — в один тап (SCREENS §9).
      save_payment_method: true,
      metadata: { user_id: input.userId, plan: input.plan },
    }),
  });

  if (!response.ok) {
    throw new Error(`ЮKassa вернула ${response.status} на создание платежа`);
  }
  const body = (await response.json()) as {
    id?: unknown;
    status?: unknown;
    confirmation?: { confirmation_url?: unknown };
  };
  return {
    id: typeof body.id === 'string' ? body.id : '',
    status: typeof body.status === 'string' ? body.status : '',
    confirmationUrl:
      typeof body.confirmation?.confirmation_url === 'string'
        ? body.confirmation.confirmation_url
        : null,
  };
}
