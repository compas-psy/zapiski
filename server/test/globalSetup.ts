import { createPool } from '../src/db/pool.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { requireDatabase, startEphemeralPostgres, type EphemeralCluster } from './helpers/pg.ts';

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
      // 22 файла тестов обёрнуты в describe.skipIf(noDatabase()). Без базы они
      // пропускаются, а прогон остаётся ЗЕЛЁНЫМ — то есть в CI шаг «Тесты»
      // отчитался бы успехом, не проверив ни маршрутов, ни миграций, ни
      // аутентификации. На машине разработчика это приемлемо и остаётся
      // предупреждением; в CI — падение, потому что там зелёный свет означает
      // «можно выкладывать».
      if (requireDatabase(process.env)) {
        throw new Error(
          'Postgres не найден, а в CI база обязательна: без неё молча пропустились бы ' +
            'все тесты с describe.skipIf(noDatabase()) — маршруты, миграции, вход. ' +
            'Поднимите Postgres или задайте TEST_DATABASE_URL. ' +
            'Сознательный прогон без базы — только ZAPISKI_ALLOW_NO_DATABASE=1.',
        );
      }
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
