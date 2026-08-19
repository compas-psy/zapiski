import type { SubscriptionPlan, SubscriptionStatus } from '../protocol.ts';
import type { Db, DbClient } from '../db/pool.ts';

/**
 * Подписка (ТЗ §5.5) и — главное — правило, ради которого она здесь описана
 * отдельным модулем:
 *
 * **Истечение подписки не блокирует данные.** Чтение блобов, версий и
 * CRDT-апдейтов доступно всегда. Запрещается только запись новых.
 * ARCHITECTURE §3 и SCREENS §9 («блокировка доступа к уже созданным заметкам»
 * — в списке запрещённого). Поэтому `canWrite` — единственное, что этот модуль
 * умеет запрещать, и ни один read-хендлер его не спрашивает.
 */

export interface SubscriptionRow {
  user_id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  trial_started_at: Date | null;
  trial_ends_at: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  grace_ends_at: Date | null;
  provider: 'yookassa' | 'google_play' | 'tbank' | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  auto_renew: boolean;
}

export interface Entitlement {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  /** Можно ли писать в облако прямо сейчас. */
  canWrite: boolean;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  trialEndsAt: Date | null;
  autoRenew: boolean;
  /** ТЗ §4.2: 30 дней пробный / 365 подписка. */
  versionRetentionDays: number;
}

export interface RetentionPolicy {
  trialDays: number;
  paidDays: number;
}

const SELECT = `
  SELECT user_id, plan, status, trial_started_at, trial_ends_at,
         current_period_start, current_period_end, grace_ends_at,
         provider, provider_customer_id, provider_subscription_id, auto_renew
    FROM subscriptions
   WHERE user_id = $1
`;

export async function getSubscriptionRow(
  db: Db | DbClient,
  userId: string,
): Promise<SubscriptionRow | null> {
  const { rows } = await db.query<SubscriptionRow>(SELECT, [userId]);
  return rows[0] ?? null;
}

/** Создаёт строку подписки со значениями по умолчанию, если её ещё нет. */
export async function ensureSubscription(
  db: Db | DbClient,
  userId: string,
): Promise<SubscriptionRow> {
  await db.query(
    `INSERT INTO subscriptions (user_id, plan, status)
     VALUES ($1, 'free', 'none')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const row = await getSubscriptionRow(db, userId);
  if (row === null) throw new Error('не удалось создать подписку');
  return row;
}

/**
 * Пересчитывает право на запись по календарю. Ничего не пишет в базу:
 * состояние в колонке `status` — это последнее известное от провайдера,
 * а фактическое право считается от текущего момента.
 *
 * `billingEnabled` — обязательный параметр, а не значение по умолчанию,
 * нарочно: право на запись выдаётся здесь, и каждое место, которое его
 * спрашивает, обязано сказать, действует ли сейчас оплата вообще. Забытое
 * умолчание в такой функции — это либо бесплатный доступ там, где он оплачен,
 * либо отказ в записи там, где всё бесплатно; второе мы уже показывали
 * человеку и повторять не хотим.
 */
export function evaluate(
  row: SubscriptionRow | null,
  retention: RetentionPolicy,
  billingEnabled: boolean,
  now: Date = new Date(),
): Entitlement {
  /*
   * Оплата выключена — писать может каждый вошедший, и разговора о подписке
   * нет вовсе. Статус при этом честный: `none` означает «подписки нет», а не
   * «была и кончилась». Именно на это смотрит текст ошибки, если оплату
   * когда-нибудь включат.
   */
  if (!billingEnabled) {
    return {
      plan: row?.plan ?? 'free',
      status: 'none',
      canWrite: true,
      currentPeriodEnd: row?.current_period_end ?? null,
      graceEndsAt: row?.grace_ends_at ?? null,
      trialEndsAt: row?.trial_ends_at ?? null,
      autoRenew: row?.auto_renew ?? false,
      /* История версий — по самому щедрому сроку: он и так не про деньги,
         пока денег нет. */
      versionRetentionDays: retention.paidDays,
    };
  }

  const base: Entitlement = {
    plan: row?.plan ?? 'free',
    status: 'none',
    canWrite: false,
    currentPeriodEnd: row?.current_period_end ?? null,
    graceEndsAt: row?.grace_ends_at ?? null,
    trialEndsAt: row?.trial_ends_at ?? null,
    autoRenew: row?.auto_renew ?? false,
    versionRetentionDays: retention.trialDays,
  };

  if (row === null) return base;

  const ms = now.getTime();
  const active = row.current_period_end !== null && row.current_period_end.getTime() > ms;
  const inTrial = row.trial_ends_at !== null && row.trial_ends_at.getTime() > ms;
  const inGrace = row.grace_ends_at !== null && row.grace_ends_at.getTime() > ms;

  if (active) {
    return {
      ...base,
      status: 'active',
      canWrite: true,
      versionRetentionDays: retention.paidDays,
    };
  }
  if (inGrace) {
    // Льготный период: продление не прошло, но пользователь ещё платящий —
    // запись не отбираем.
    return {
      ...base,
      status: 'grace',
      canWrite: true,
      versionRetentionDays: retention.paidDays,
    };
  }
  if (inTrial) {
    return {
      ...base,
      status: 'trial',
      canWrite: true,
      versionRetentionDays: retention.trialDays,
    };
  }

  // Всё истекло. Данные остаются доступны на чтение — блокировки нет.
  const everPaid = row.current_period_end !== null || row.trial_ends_at !== null;
  return {
    ...base,
    status: everPaid ? 'expired' : 'none',
    canWrite: false,
    versionRetentionDays: row.current_period_end !== null ? retention.paidDays : retention.trialDays,
  };
}

export async function getEntitlement(
  db: Db | DbClient,
  userId: string,
  retention: RetentionPolicy,
  billingEnabled: boolean,
  now: Date = new Date(),
): Promise<Entitlement> {
  const row = await getSubscriptionRow(db, userId);
  return evaluate(row, retention, billingEnabled, now);
}

export interface StartTrialResult {
  started: boolean;
  entitlement: Entitlement;
}

/**
 * SCREENS §9: кнопка «Попробовать 14 дней». Пробный период даётся один раз;
 * повторный вызов не продлевает его и не считается ошибкой.
 */
export async function startTrial(
  db: Db | DbClient,
  userId: string,
  trialDays: number,
  retention: RetentionPolicy,
  billingEnabled: boolean,
  now: Date = new Date(),
): Promise<StartTrialResult> {
  await ensureSubscription(db, userId);
  const endsAt = new Date(now.getTime() + trialDays * 86_400_000);

  const { rows } = await db.query<SubscriptionRow>(
    `UPDATE subscriptions
        SET plan = 'trial',
            status = 'trial',
            trial_started_at = $2,
            trial_ends_at = $3,
            updated_at = now()
      WHERE user_id = $1
        AND trial_started_at IS NULL
        AND current_period_end IS NULL
      RETURNING user_id, plan, status, trial_started_at, trial_ends_at,
                current_period_start, current_period_end, grace_ends_at,
                provider, provider_customer_id, provider_subscription_id, auto_renew`,
    [userId, now, endsAt],
  );

  if (rows[0] !== undefined) {
    return { started: true, entitlement: evaluate(rows[0], retention, billingEnabled, now) };
  }
  return {
    started: false,
    entitlement: await getEntitlement(db, userId, retention, billingEnabled, now),
  };
}

export interface ActivationInput {
  userId: string;
  plan: 'monthly' | 'yearly';
  provider: 'yookassa' | 'google_play' | 'tbank';
  periodStart: Date;
  periodEnd: Date;
  autoRenew: boolean;
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  graceDays: number;
}

/** Продлевает/включает платный период. Идемпотентна по (provider, period). */
export async function activatePaidPeriod(
  db: Db | DbClient,
  input: ActivationInput,
): Promise<SubscriptionRow> {
  await ensureSubscription(db, input.userId);
  const graceEndsAt = new Date(input.periodEnd.getTime() + input.graceDays * 86_400_000);
  const { rows } = await db.query<SubscriptionRow>(
    `UPDATE subscriptions
        SET plan = $2,
            status = 'active',
            provider = $3,
            current_period_start = $4,
            current_period_end = GREATEST(COALESCE(current_period_end, $4), $5),
            grace_ends_at = $6,
            auto_renew = $7,
            provider_subscription_id = COALESCE($8, provider_subscription_id),
            provider_customer_id = COALESCE($9, provider_customer_id),
            updated_at = now()
      WHERE user_id = $1
      RETURNING user_id, plan, status, trial_started_at, trial_ends_at,
                current_period_start, current_period_end, grace_ends_at,
                provider, provider_customer_id, provider_subscription_id, auto_renew`,
    [
      input.userId,
      input.plan,
      input.provider,
      input.periodStart,
      input.periodEnd,
      graceEndsAt,
      input.autoRenew,
      input.providerSubscriptionId ?? null,
      input.providerCustomerId ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('подписка не найдена');
  return row;
}

/** Отмена автопродления. Доступ до конца оплаченного периода сохраняется. */
export async function cancelAutoRenew(db: Db | DbClient, userId: string): Promise<void> {
  await db.query(
    `UPDATE subscriptions SET auto_renew = false, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
}

/** Отметка «платёж не прошёл»: переводим в grace, но не отбираем данные. */
export async function markPaymentFailed(
  db: Db | DbClient,
  userId: string,
  graceDays: number,
  now: Date = new Date(),
): Promise<void> {
  const graceEndsAt = new Date(now.getTime() + graceDays * 86_400_000);
  await db.query(
    `UPDATE subscriptions
        SET status = 'grace',
            grace_ends_at = GREATEST(COALESCE(grace_ends_at, $2), $2),
            auto_renew = false,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, graceEndsAt],
  );
}
