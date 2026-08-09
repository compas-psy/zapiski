import type { QuotaStatus } from '../protocol.ts';
import type { Db, DbClient } from '../db/pool.ts';

/**
 * Учёт занятого объёма (ТЗ §7: 10 ГБ на аккаунт).
 *
 * Счётчики двигаются в той же транзакции, что и запись файла, поэтому не
 * разъезжаются с фактом. Проверка «влезет ли» делается на строке `quota_usage`,
 * взятой под `FOR UPDATE`: без блокировки два параллельных PUT могут оба
 * увидеть свободное место и вдвоём его превысить.
 */

export type QuotaBucket = 'blob_bytes' | 'version_bytes' | 'crdt_bytes' | 'published_bytes';

export interface QuotaSnapshot {
  blobBytes: number;
  versionBytes: number;
  crdtBytes: number;
  publishedBytes: number;
  blobCount: number;
  totalBytes: number;
}

interface QuotaRow {
  blob_bytes: number;
  version_bytes: number;
  crdt_bytes: number;
  published_bytes: number;
  blob_count: number;
}

const COLUMNS = 'blob_bytes, version_bytes, crdt_bytes, published_bytes, blob_count';

export async function ensureQuotaRow(db: Db | DbClient, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO quota_usage (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

export async function readUsage(db: Db | DbClient, userId: string): Promise<QuotaSnapshot> {
  const { rows } = await db.query<QuotaRow>(
    `SELECT ${COLUMNS} FROM quota_usage WHERE user_id = $1`,
    [userId],
  );
  return toSnapshot(rows[0]);
}

export async function quotaStatus(
  db: Db | DbClient,
  userId: string,
  limitBytes: number,
): Promise<QuotaStatus> {
  const usage = await readUsage(db, userId);
  return { usedBytes: usage.totalBytes, limitBytes };
}

/**
 * Берёт строку учёта под блокировку и возвращает текущее состояние.
 * Вызывать только внутри транзакции.
 */
export async function lockUsage(client: DbClient, userId: string): Promise<QuotaSnapshot> {
  await ensureQuotaRow(client, userId);
  const { rows } = await client.query<QuotaRow>(
    `SELECT ${COLUMNS} FROM quota_usage WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return toSnapshot(rows[0]);
}

export interface QuotaDelta {
  bucket: QuotaBucket;
  bytes: number;
  blobCountDelta?: number;
}

/** Применяет дельту к счётчикам. Вызывать внутри той же транзакции. */
export async function applyDelta(
  client: DbClient,
  userId: string,
  delta: QuotaDelta,
): Promise<void> {
  if (delta.bytes === 0 && !delta.blobCountDelta) return;
  await client.query(
    `UPDATE quota_usage
        SET ${delta.bucket} = GREATEST(0, ${delta.bucket} + $2),
            blob_count = GREATEST(0, blob_count + $3),
            updated_at = now()
      WHERE user_id = $1`,
    [userId, delta.bytes, delta.blobCountDelta ?? 0],
  );
}

/** Влезет ли `delta` байт сверх текущего расхода. */
export function fits(usage: QuotaSnapshot, deltaBytes: number, limitBytes: number): boolean {
  if (deltaBytes <= 0) return true;
  return usage.totalBytes + deltaBytes <= limitBytes;
}

/**
 * Полный пересчёт из фактических строк — на случай, если счётчики всё же
 * разошлись (ручное вмешательство, восстановление из бэкапа).
 */
export async function recalculate(db: Db | DbClient, userId: string): Promise<QuotaSnapshot> {
  await ensureQuotaRow(db, userId);
  await db.query(
    `UPDATE quota_usage q
        SET blob_bytes = COALESCE(b.bytes, 0),
            blob_count = COALESCE(b.count, 0),
            version_bytes = COALESCE(v.bytes, 0),
            crdt_bytes = COALESCE(c.bytes, 0),
            published_bytes = COALESCE(p.bytes, 0),
            updated_at = now()
       FROM (SELECT 1) AS _
       LEFT JOIN LATERAL (
         SELECT SUM(size)::bigint AS bytes, COUNT(*)::int AS count
           FROM blobs WHERE user_id = $1 AND deleted_at IS NULL
       ) b ON true
       LEFT JOIN LATERAL (
         SELECT SUM(size)::bigint AS bytes FROM versions WHERE user_id = $1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT SUM(size)::bigint AS bytes FROM crdt_updates WHERE user_id = $1
       ) c ON true
       LEFT JOIN LATERAL (
         SELECT SUM(size)::bigint AS bytes
           FROM published_pages WHERE user_id = $1 AND revoked_at IS NULL
       ) p ON true
      WHERE q.user_id = $1`,
    [userId],
  );
  return readUsage(db, userId);
}

function toSnapshot(row: QuotaRow | undefined): QuotaSnapshot {
  const blobBytes = row?.blob_bytes ?? 0;
  const versionBytes = row?.version_bytes ?? 0;
  const crdtBytes = row?.crdt_bytes ?? 0;
  const publishedBytes = row?.published_bytes ?? 0;
  return {
    blobBytes,
    versionBytes,
    crdtBytes,
    publishedBytes,
    blobCount: row?.blob_count ?? 0,
    totalBytes: blobBytes + versionBytes + crdtBytes + publishedBytes,
  };
}
