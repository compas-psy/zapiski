import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool, type Db } from './pool.ts';

/**
 * Раннер миграций: применяет `migrations/*.sql` по возрастанию имени, каждую в
 * своей транзакции, и запоминает применённые в таблице `schema_migrations`.
 *
 * Контрольная сумма защищает от правки уже применённого файла: если содержимое
 * разошлось с тем, что накатывали, раннер останавливается вместо тихого
 * расхождения схемы между окружениями.
 */

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export async function runMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  await db.query(CREATE_TABLE);

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const alreadyApplied = new Map(rows.map((r) => [r.version, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');

    const known = alreadyApplied.get(version);
    if (known !== undefined) {
      if (known !== checksum) {
        throw new Error(
          `Миграция ${version} уже применена, но её содержимое изменилось. ` +
            'Правка применённой миграции запрещена — добавьте новую.',
        );
      }
      skipped.push(version);
      continue;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [version, checksum],
      );
      await client.query('COMMIT');
      applied.push(version);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Миграция ${version} не применилась: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

/** Точка входа `npm run migrate`. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL не задан');
    process.exitCode = 1;
    return;
  }
  const db = createPool(url, 2);
  try {
    const result = await runMigrations(db);
    if (result.applied.length === 0) {
      console.log(`Миграции актуальны (применено ранее: ${result.skipped.length}).`);
    } else {
      console.log(`Применены миграции: ${result.applied.join(', ')}`);
    }
  } finally {
    await db.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
