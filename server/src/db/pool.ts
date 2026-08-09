import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

/**
 * bigint (int8) Postgres отдаёт строкой, чтобы не терять точность.
 * Размеры блобов и квоты укладываются в Number.MAX_SAFE_INTEGER (9 ПБ),
 * поэтому приводим к number — иначе арифметика по квоте становится строковой.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

export function createPool(databaseUrl: string, max = 10): Db {
  return new pg.Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'zapiski-api',
  });
}

/** Выполняет тело в транзакции; при исключении — ROLLBACK. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Соединение уже могло умереть — исходную ошибку это не отменяет.
    }
    throw error;
  } finally {
    client.release();
  }
}
