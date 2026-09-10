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
import { createPracticeBridge, retryPracticeForwarding } from './services/practiceBridge.ts';
import { pruneExpiredVersions } from './routes/versions.ts';
import { startSweeper } from './services/sweep.ts';

/**
 * Точка входа ZapiskiCloud.
 *
 * ADR-0003 §2: слушаем порт 3100. Порты 3000 (КОМПАС.Дневник) и 25 (почта) на
 * этом хосте не трогаются — ни здесь, ни в конфигурации.
 */


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
    practiceBridge: createPracticeBridge(env),
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
  // Честно и явно, а не молча (C4): без обеих переменных мост в ПРАКТИКУ
  // выключен, событие остаётся только у ЗАПИСОК.
  if (ctx.practiceBridge === null) {
    app.log.warn('PRACTICE_INGEST_URL/SECRET не заданы — мост в приёмник ПРАКТИКИ выключен');
  }

  // Уборка: просроченные версии (ТЗ §4.2), отработавшие magic-токены и
  // повтор пересылки в ПРАКТИКУ для событий, не дошедших с первой попытки
  // (C4) — тот же цикл, не отдельный таймер: пересылка не настолько
  // срочная, чтобы заводить под неё собственную инфраструктуру.
  const stopSweeper = startSweeper(async () => {
    try {
      const versions = await pruneExpiredVersions(ctx, ctx.now());
      const tokens = await pruneMagicTokens(db, ctx.now());
      const bridge = await retryPracticeForwarding(ctx);
      if (versions > 0 || tokens > 0 || bridge.attempted > 0) {
        app.log.info(
          { event: 'sweep', versions, tokens, practiceForwarded: bridge.forwarded, practiceAttempted: bridge.attempted },
          'уборка завершена',
        );
      }
    } catch (error) {
      app.log.error({ err: error, event: 'sweep_failed' }, 'уборка не прошла');
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ event: 'shutdown', signal }, 'останавливаемся');
    stopSweeper();
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
