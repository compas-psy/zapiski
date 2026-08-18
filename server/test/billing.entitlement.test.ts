import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trialDaysFor } from '../src/lib/trial.ts';

import { REGISTRY } from '../src/lib/messages.ts';
import { evaluate } from '../src/services/subscription.ts';
import {
  createHarness,
  createUser,
  expireSubscription,
  noDatabase,
  type Harness,
} from './helpers/app.ts';

/**
 * ТЗ §5.5 — правило, которое важнее любой другой логики биллинга:
 *
 *   «при истечении подписки данные НЕ блокируются — API продолжает отдавать
 *    блобы на чтение, запрещается только запись новых».
 *
 * SCREENS §9 повторяет это в списке запрещённого: «блокировка доступа к уже
 * созданным заметкам». Ниже это зафиксировано так, чтобы случайно снять
 * проверку было нельзя: отдельно чтение, отдельно запись, отдельно текст.
 */

const RETENTION = { trialDays: 30, paidDays: 365 };

describe.skipIf(noDatabase())('подписка и доступ к данным', () => {
  let harness: Harness;

  beforeAll(async () => {
    /* Этот набор описывает продукт С ВКЛЮЧЁННОЙ оплатой: у сервера она по
       умолчанию выключена (MVP бесплатный), и без этой строки проверять было
       бы нечего — писать может каждый. */
    harness = await createHarness({ env: { BILLING_ENABLED: '1' } });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('истёкшая подписка: чтение работает, запись — нет', async () => {
    const user = await createUser(harness);
    const authedBinary = { ...user.authHeader, 'content-type': 'application/octet-stream' };

    // Пишем, пока подписка ещё действует.
    const written = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/важная.md.enc',
      headers: authedBinary,
      payload: Buffer.from('зашифрованное содержимое'),
    });
    expect(written.statusCode).toBe(200);
    const etag = (written.json() as { etag: string }).etag;

    await expireSubscription(harness, user.userId);

    // ── Чтение: всё на месте ────────────────────────────────────────────────
    const blob = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/blob/важная.md.enc',
      headers: user.authHeader,
    });
    expect(blob.statusCode).toBe(200);
    expect(blob.rawPayload.toString()).toBe('зашифрованное содержимое');
    expect(blob.headers['etag']).toBe(etag);

    const manifest = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/manifest',
      headers: user.authHeader,
    });
    expect(manifest.statusCode).toBe(200);
    expect((manifest.json() as { entries: unknown[] }).entries).toHaveLength(1);

    const versions = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/versions/note-1',
      headers: user.authHeader,
    });
    expect(versions.statusCode).toBe(200);

    const crdt = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/vault/crdt/note-1',
      headers: user.authHeader,
    });
    expect(crdt.statusCode).toBe(200);

    // ── Запись: запрещена, с текстом из реестра ─────────────────────────────
    const blocked = await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/новая.md.enc',
      headers: authedBinary,
      payload: Buffer.from('новые данные'),
    });
    expect(blocked.statusCode).toBe(402);
    const error = blocked.json() as { error: { code: string; message: string } };
    expect(error.error.code).toBe('subscription_expired');
    expect(error.error.message).toBe(REGISTRY.subscriptionExpired);
    expect(error.error.message).toBe(
      'Подписка закончилась. Заметки на месте, синхронизация через облако КОМПАС приостановлена',
    );

    const blockedCrdt = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/crdt/note-1',
      headers: authedBinary,
      payload: Buffer.from([9, 9, 9]),
    });
    expect(blockedCrdt.statusCode).toBe(402);

    const blockedVersion = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/vault/versions/note-1',
      headers: authedBinary,
      payload: Buffer.from('снимок'),
    });
    expect(blockedVersion.statusCode).toBe(402);
  });

  it('удаление остаётся доступным после истечения — иначе выйти из квоты нельзя', async () => {
    const user = await createUser(harness);
    await harness.app.inject({
      method: 'PUT',
      url: '/api/v1/vault/blob/лишнее.bin',
      headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('мусор'),
    });
    await expireSubscription(harness, user.userId);

    const response = await harness.app.inject({
      method: 'DELETE',
      url: '/api/v1/vault/blob/лишнее.bin',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(204);
  });

  it('пробный период включается один раз, длина — по правилу MVP', async () => {
    const user = await createUser(harness, { subscribed: false });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/trial',
      headers: user.authHeader,
    });
    expect(first.statusCode).toBe(201);
    const started = first.json() as {
      started: boolean;
      canWrite: boolean;
      status: string;
      trialEndsAt: string;
      versionRetentionDays: number;
    };
    expect(started.started).toBe(true);
    expect(started.canWrite).toBe(true);
    expect(started.status).toBe('trial');
    expect(started.versionRetentionDays).toBe(30);

    /*
     * Длина берётся из правила, а не из константы теста: в MVP это 30 дней для
     * подключивших облако до 01.09.2026 и 14 после (решение заказчика). Число
     * здесь и текст на экране подключения считает одна и та же функция —
     * зафиксировать в тесте «14» значило бы через две недели получить зелёный
     * тест при неверном обещании человеку.
     */
    const days = (new Date(started.trialEndsAt).getTime() - harness.ctx.now().getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(trialDaysFor(harness.ctx.now().getTime()));

    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/billing/trial',
      headers: user.authHeader,
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { started: boolean }).started).toBe(false);
  });

  it('статус отдаёт цены 199/149 и квоту 10 ГБ', async () => {
    const user = await createUser(harness);
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: user.authHeader,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      prices: { monthlyRub: number; yearlyMonthlyRub: number };
      quota: { limitBytes: number };
      canWrite: boolean;
      versionRetentionDays: number;
    };
    expect(body.prices.monthlyRub).toBe(199);
    expect(body.prices.yearlyMonthlyRub).toBe(149);
    expect(body.quota.limitBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(body.canWrite).toBe(true);
    expect(body.versionRetentionDays).toBe(365);
  });

  it('срок хранения версий: 30 дней на пробном, 365 на подписке', async () => {
    const trialUser = await createUser(harness, { subscribed: false, trial: true });
    const trialStatus = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: trialUser.authHeader,
    });
    expect((trialStatus.json() as { versionRetentionDays: number }).versionRetentionDays).toBe(30);
  });
});

describe('расчёт права на запись', () => {
  const base = {
    user_id: 'u',
    plan: 'monthly' as const,
    status: 'active' as const,
    trial_started_at: null,
    trial_ends_at: null,
    current_period_start: null,
    current_period_end: null,
    grace_ends_at: null,
    provider: null,
    provider_customer_id: null,
    provider_subscription_id: null,
    auto_renew: false,
  };
  const now = new Date('2026-08-09T00:00:00Z');
  const future = new Date('2026-09-09T00:00:00Z');
  const past = new Date('2026-07-09T00:00:00Z');

  it('оплаченный период — запись есть, хранение 365 дней', () => {
    const result = evaluate({ ...base, current_period_end: future }, RETENTION, true, now);
    expect(result.canWrite).toBe(true);
    expect(result.status).toBe('active');
    expect(result.versionRetentionDays).toBe(365);
  });

  it('льготный период — запись ещё есть', () => {
    const result = evaluate(
      { ...base, current_period_end: past, grace_ends_at: future },
      RETENTION,
      true,
      now,
    );
    expect(result.canWrite).toBe(true);
    expect(result.status).toBe('grace');
  });

  it('пробный период — запись есть, хранение 30 дней', () => {
    const result = evaluate(
      { ...base, plan: 'trial', status: 'trial', trial_ends_at: future },
      RETENTION,
      true,
      now,
    );
    expect(result.canWrite).toBe(true);
    expect(result.status).toBe('trial');
    expect(result.versionRetentionDays).toBe(30);
  });

  it('всё истекло — записи нет, но это не «нет доступа»', () => {
    const result = evaluate(
      { ...base, current_period_end: past, grace_ends_at: past },
      RETENTION,
      true,
      now,
    );
    expect(result.canWrite).toBe(false);
    expect(result.status).toBe('expired');
  });

  it('без подписки вовсе — статус none', () => {
    const result = evaluate({ ...base, plan: 'free', status: 'none' }, RETENTION, true, now);
    expect(result.canWrite).toBe(false);
    expect(result.status).toBe('none');
  });
});
