import { createPool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { startEphemeralPostgres, type EphemeralCluster } from './helpers/pg.ts';

/**
 * Один Postgres на весь прогон: миграции накатываются один раз, а тесты
 * изолируются друг от друга собственными пользователями, а не собственными
 * базами. Это и быстрее, и ближе к бою, где база тоже общая.
 */

let cluster: EphemeralCluster | null = null;

export async function setup(): Promise<void> {
  let url = process.env['TEST_DATABASE_URL'] ?? '';

  if (url.length === 0) {
    cluster = await startEphemeralPostgres();
    if (cluster === null) {
      console.warn(
        'Postgres недоступен: тесты, которым нужна база, будут пропущены. ' +
          'Задайте TEST_DATABASE_URL, чтобы прогнать их полностью.',
      );
      process.env['TEST_DATABASE_URL'] = '';
      return;
    }
    url = cluster.url;
  }

  const db = createPool(url, 2);
  try {
    await runMigrations(db);
  } finally {
    await db.end();
  }

  process.env['TEST_DATABASE_URL'] = url;
}

export async function teardown(): Promise<void> {
  if (cluster !== null) {
    await cluster.stop();
    cluster = null;
  }
}
