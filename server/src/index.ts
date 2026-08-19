import { buildApp } from './app.ts';
import { loadEnv } from './config/env.ts';
import type { AppContext } from './context.ts';
import { createPool } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';
import { pruneMagicTokens } from './services/accounts.ts';
import { BlobStore } from './services/blobStore.ts';
import { LiveBus } from './services/liveBus.ts';
import { SmtpMailer } from './services/mailer.ts';
import { YandexOAuth } from './services/yandex.ts';
import { pruneExpiredVersions } from './routes/versions.ts';

/**
 * Точка входа ZapiskiCloud.
 *
 * ADR-0003 §2: слушаем порт 3100. Порты 3000 (КОМПАС.Дневник) и 25 (почта) на
 * этом хосте не трогаются — ни здесь, ни в конфигурации.
 */

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);

  // Схема доводится до актуальной на старте: контейнер поднимается сам, без
  // отдельного шага в деплое, который можно забыть.
  await runMigrations(db);

  const ctx: AppContext = {
    env,
    db,
    blobs: new BlobStore(env.BLOB_ROOT),
    mailer: new SmtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      localRelayWithoutCertificate: env.SMTP_LOCAL_RELAY,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.MAIL_FROM,
    }),
    live: new LiveBus(),
    yandex:
      env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET
        ? new YandexOAuth({
            clientId: env.YANDEX_CLIENT_ID,
            clientSecret: env.YANDEX_CLIENT_SECRET,
            redirectUri:
              env.YANDEX_REDIRECT_URI ??
              `${env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/auth/yandex/callback`,
          })
        : null,
    retention: {
      trialDays: env.VERSION_RETENTION_TRIAL_DAYS,
      paidDays: env.VERSION_RETENTION_PAID_DAYS,
    },
    now: () => new Date(),
  };

  const app = await buildApp(ctx);

  if (ctx.yandex === null) {
    app.log.warn('YANDEX_CLIENT_ID/SECRET не заданы — вход через Яндекс ID выключен');
  }

  // Уборка: просроченные версии (ТЗ §4.2) и отработавшие magic-токены.
  const sweeper = setInterval(() => {
    void (async () => {
      try {
        const versions = await pruneExpiredVersions(ctx, ctx.now());
        const tokens = await pruneMagicTokens(db, ctx.now());
        if (versions > 0 || tokens > 0) {
          app.log.info({ event: 'sweep', versions, tokens }, 'уборка завершена');
        }
      } catch (error) {
        app.log.error({ err: error, event: 'sweep_failed' }, 'уборка не прошла');
      }
    })();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ event: 'shutdown', signal }, 'останавливаемся');
    clearInterval(sweeper);
    try {
      await app.close();
      await db.end();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
