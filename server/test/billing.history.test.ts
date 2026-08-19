import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getSubscriptionRow } from '../src/services/subscription.ts';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';

/**
 * История платежей переживает удаление эквайринга.
 *
 * ── Что решено ──────────────────────────────────────────────────────────────
 *
 * Решение учредителя от 18.08.2026: Т-Касса — единственный эквайринг. ЮKassa и
 * Google Play удалены из кода: мёртвый платёжный путь опаснее отсутствующего,
 * потому что выглядит рабочим.
 *
 * ── Что при этом НЕЛЬЗЯ ─────────────────────────────────────────────────────
 *
 * Удалить код — не то же самое, что удалить прошлое. В базе остались платежи
 * этих провайдеров, включая непроведённые. Если сузить типы или CHECK-
 * ограничение, старые строки перестанут читаться: подписка человека,
 * заплатившего через ЮKassa, не разберётся, а миграция упадёт на живой базе —
 * и обнаружится это уже на проде.
 *
 * Поэтому здесь проверяется не «код удалён» (это видно и без теста), а то,
 * что после удаления история ЧИТАЕТСЯ.
 */

describe.skipIf(noDatabase())('история платежей удалённых провайдеров', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ env: { BILLING_ENABLED: '1' } });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('подписка, оплаченная через ЮKassa, читается и отдаётся в статусе', async () => {
    const user = await createUser(harness);

    /* Ровно то, что лежит в базе с апреля: платный период от провайдера,
       которого в коде больше нет. */
    await harness.db.query(
      `UPDATE subscriptions
          SET provider = 'yookassa',
              provider_customer_id = 'yk-cust-1',
              provider_subscription_id = 'yk-sub-1'
        WHERE user_id = $1`,
      [user.userId],
    );

    const row = await getSubscriptionRow(harness.db, user.userId);
    expect(row?.provider, 'провайдер из истории не разобрался').toBe('yookassa');
    expect(row?.provider_subscription_id).toBe('yk-sub-1');

    /* Страница подписки в приложении держится на этой ручке. Если чтение
       истории сломано, человек с апрельской оплатой увидит вместо подписки
       ошибку — при том, что деньги он заплатил. */
    const status = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { status: string; canWrite: boolean };
    expect(body.status).toBe('active');
    expect(body.canWrite).toBe(true);
  });

  it('подписка Google Play читается так же', async () => {
    const user = await createUser(harness);
    await harness.db.query(
      `UPDATE subscriptions SET provider = 'google_play' WHERE user_id = $1`,
      [user.userId],
    );

    const row = await getSubscriptionRow(harness.db, user.userId);
    expect(row?.provider).toBe('google_play');

    const status = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    expect(status.statusCode).toBe(200);
  });

  it('журнал событий по-прежнему принимает и отдаёт строки обоих провайдеров', async () => {
    /* Сужение CHECK'а сделало бы старые строки нечитаемыми, а саму миграцию —
       падающей на проде. Проверяем прямой записью: если ограничение сузили,
       вставка упадёт здесь, а не у заказчика. */
    const user = await createUser(harness);
    for (const provider of ['yookassa', 'google_play', 'tbank'] as const) {
      await harness.db.query(
        `INSERT INTO billing_events (provider, event_id, user_id, event_type, payload)
         VALUES ($1, $2, $3, 'payment.succeeded', '{}'::jsonb)`,
        [provider, `history-${provider}-${user.userId}`, user.userId],
      );
    }

    const rows = await harness.db.query<{ provider: string }>(
      `SELECT provider FROM billing_events WHERE user_id = $1 ORDER BY provider`,
      [user.userId],
    );
    expect(rows.rows.map((r) => r.provider)).toEqual(['google_play', 'tbank', 'yookassa']);
  });

  it('ограничение на провайдера в схеме не сужено', async () => {
    /* Сторож на будущее: следующая миграция, которая «приберёт лишние
       значения», молча отрежет историю. Читаем само ограничение, а не
       догадываемся по поведению. */
    for (const table of ['subscriptions', 'billing_events']) {
      const check = await harness.db.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = $1 AND c.conname = $1 || '_provider_check'`,
        [table],
      );
      const definition = check.rows[0]?.definition ?? '';
      expect(definition, `${table}: ограничения на провайдера нет вовсе`).not.toBe('');
      for (const provider of ['yookassa', 'google_play', 'tbank']) {
        expect(definition, `${table}: значение ${provider} больше не разрешено`).toContain(provider);
      }
    }
  });
});
