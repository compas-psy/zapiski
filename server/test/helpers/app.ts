import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { loadEnv, type Env } from '../../src/config/env.ts';
import type { AppContext } from '../../src/context.ts';
import { createPool, type Db } from '../../src/db/pool.ts';
import { signJwt } from '../../src/lib/jwt.ts';
import { BlobStore } from '../../src/services/blobStore.ts';
import { LiveBus } from '../../src/services/liveBus.ts';
import { MemoryMailer } from '../../src/services/mailer.ts';
import {
  createSession,
  ensureDevice,
  upsertUserByEmail,
} from '../../src/services/accounts.ts';
import { ensureSubscription } from '../../src/services/subscription.ts';
import { ensureQuotaRow } from '../../src/services/quota.ts';

/**
 * Тестовый стенд: настоящее приложение поверх настоящей базы и настоящего
 * тома во временном каталоге. Подменены ровно две вещи — почта и часы.
 */

export const TEST_AUTH_SECRET = 'test-secret-for-hs256-not-used-anywhere-else';

export function databaseUrl(): string | null {
  const url = process.env['TEST_DATABASE_URL'];
  return url !== undefined && url.length > 0 ? url : null;
}

/** Базы нет — набор помечается пропущенным через `describe.skipIf`. */
export const noDatabase = (): boolean => databaseUrl() === null;

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  mailer: MemoryMailer;
  blobRoot: string;
  /** Управляемые часы: тесты TTL двигают время вперёд. */
  setNow: (date: Date) => void;
  advance: (ms: number) => void;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  env?: Partial<Record<string, string>>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const url = databaseUrl();
  if (url === null) throw new Error('TEST_DATABASE_URL не задан');

  const blobRoot = await mkdtemp(path.join(tmpdir(), 'zapiski-blobs-'));
  const env: Env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    AUTH_SECRET: TEST_AUTH_SECRET,
    BLOB_ROOT: blobRoot,
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: 'https://zapiski.test',
    ...options.env,
  } as NodeJS.ProcessEnv);

  const db = createPool(url, 5);
  const mailer = new MemoryMailer();
  // Часы стартуют от настоящего времени, а не от зашитой даты: часть проверок
  // (срок версии, `used_at`) смотрит на `now()` самой базы, и зашитая дата
  // разъезжалась бы с ней тем сильнее, чем позже прогон.
  let now = new Date();

  const ctx: AppContext = {
    env,
    db,
    blobs: new BlobStore(blobRoot),
    mailer,
    live: new LiveBus(),
    yandex: null,
    retention: {
      trialDays: env.VERSION_RETENTION_TRIAL_DAYS,
      paidDays: env.VERSION_RETENTION_PAID_DAYS,
    },
    now: () => now,
  };

  const app = await buildApp(ctx);
  await app.ready();

  return {
    app,
    ctx,
    db,
    mailer,
    blobRoot,
    setNow: (date) => {
      now = date;
    },
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
    close: async () => {
      await app.close();
      await db.end();
      await rm(blobRoot, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  userId: string;
  deviceId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  authHeader: { authorization: string };
}

let userCounter = 0;

/**
 * Заводит пользователя напрямую в базе — вход как таковой проверяется
 * отдельными тестами, а здесь он был бы шумом.
 */
export async function createUser(
  harness: Harness,
  options: { subscribed?: boolean; trial?: boolean } = {},
): Promise<TestUser> {
  userCounter += 1;
  const email = `user${userCounter}.${process.pid}@example.test`;
  const user = await upsertUserByEmail(harness.db, email);
  const deviceId = await ensureDevice(harness.db, user.id, `device-${userCounter}-abcdef`, 'web');
  await ensureSubscription(harness.db, user.id);
  await ensureQuotaRow(harness.db, user.id);

  const now = harness.ctx.now();
  if (options.subscribed !== false) {
    const end = new Date(now.getTime() + 30 * 86_400_000);
    await harness.db.query(
      `UPDATE subscriptions
          SET plan = 'monthly', status = 'active',
              current_period_start = $2, current_period_end = $3,
              grace_ends_at = $3, auto_renew = true
        WHERE user_id = $1`,
      [user.id, now, end],
    );
  }
  if (options.trial === true) {
    const end = new Date(now.getTime() + 14 * 86_400_000);
    await harness.db.query(
      `UPDATE subscriptions
          SET plan = 'trial', status = 'trial',
              trial_started_at = $2, trial_ends_at = $3,
              current_period_start = NULL, current_period_end = NULL, grace_ends_at = NULL
        WHERE user_id = $1`,
      [user.id, now, end],
    );
  }

  const session = await createSession(
    harness.db,
    { userId: user.id, deviceId, ttlSeconds: harness.ctx.env.AUTH_REFRESH_TTL_SECONDS },
    now,
  );
  const accessToken = signJwt(
    { sub: user.id, sid: session.sessionId, did: deviceId, typ: 'access' },
    TEST_AUTH_SECRET,
    harness.ctx.env.AUTH_ACCESS_TTL_SECONDS,
    now.getTime(),
  );

  return {
    userId: user.id,
    deviceId,
    email,
    accessToken,
    refreshToken: session.refreshToken,
    authHeader: { authorization: `Bearer ${accessToken}` },
  };
}

/**
 * Второе устройство того же человека: своя сессия, свой `X-Device-Id`.
 *
 * Синхронизация — это не «сервер принял байты», а «второе устройство их
 * увидело». Без отдельного устройства проверить второе нечем: один и тот же
 * токен читает собственную запись даже там, где чужая не доехала бы.
 */
export async function addDevice(
  harness: Harness,
  user: TestUser,
  name: string,
): Promise<{ deviceId: string; authHeader: { authorization: string } }> {
  const deviceId = await ensureDevice(harness.db, user.userId, name, 'desktop');
  const now = harness.ctx.now();
  const session = await createSession(
    harness.db,
    { userId: user.userId, deviceId, ttlSeconds: harness.ctx.env.AUTH_REFRESH_TTL_SECONDS },
    now,
  );
  const accessToken = signJwt(
    { sub: user.userId, sid: session.sessionId, did: deviceId, typ: 'access' },
    TEST_AUTH_SECRET,
    harness.ctx.env.AUTH_ACCESS_TTL_SECONDS,
    now.getTime(),
  );
  return { deviceId, authHeader: { authorization: `Bearer ${accessToken}` } };
}

/** Помечает подписку истёкшей: право на чтение остаётся, на запись — нет. */
export async function expireSubscription(harness: Harness, userId: string): Promise<void> {
  const past = new Date(harness.ctx.now().getTime() - 86_400_000);
  await harness.db.query(
    `UPDATE subscriptions
        SET status = 'expired', current_period_end = $2, grace_ends_at = $2,
            trial_ends_at = $2, auto_renew = false
      WHERE user_id = $1`,
    [userId, past],
  );
}

export function bytes(size: number, fill = 0xab): Buffer {
  return Buffer.alloc(size, fill);
}
