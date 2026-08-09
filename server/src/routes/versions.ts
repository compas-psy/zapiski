import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { withTransaction } from '../db/pool.ts';
import { shortHash } from '../lib/crypto.ts';
import { errors } from '../lib/errors.ts';
import { isValidNoteId, normalizeVaultPath } from '../lib/vaultPath.ts';
import { authOf } from '../plugins/auth.ts';
import type { RemoteVersionSnapshot } from '../protocol.ts';
import { applyDelta, fits, lockUsage } from '../services/quota.ts';
import { getEntitlement } from '../services/subscription.ts';
import { assertCanWrite, headerValue, requireBinaryBody } from './vault.ts';

/**
 * История версий (ТЗ §4.2): 30 дней на пробном периоде, 365 на подписке.
 *
 * Версия — такой же зашифрованный блоб, как и сама заметка: сервер хранит
 * шифротекст и метаданные, содержимого не видит. Срок хранения проставляется
 * в момент записи по действующему тарифу, поэтому смена тарифа не укорачивает
 * задним числом то, что уже сохранено.
 *
 * Читать историю можно всегда, включая истёкшую подписку (ТЗ §5.5).
 */

const noteParams = z.object({ noteId: z.string() });
const versionParams = z.object({ noteId: z.string(), versionId: z.string().uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });

interface VersionRow {
  id: string;
  note_id: string;
  path: string | null;
  storage_key: string;
  etag: string;
  size: number;
  source: string;
  merged: boolean;
  taken_at: Date;
  expires_at: Date;
}

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.get(
    '/api/v1/vault/versions/:noteId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const auth = authOf(request);
      const params = noteParams.safeParse(request.params);
      if (!params.success || !isValidNoteId(params.data.noteId)) {
        throw errors.badRequest('bad_note_id');
      }
      const query = listQuery.safeParse(request.query);
      if (!query.success) throw errors.badRequest('bad_limit');

      const { rows } = await ctx.db.query<VersionRow>(
        `SELECT id, note_id, path, storage_key, etag, size, source, merged, taken_at, expires_at
           FROM versions
          WHERE user_id = $1 AND note_id = $2 AND expires_at > now()
          ORDER BY taken_at DESC
          LIMIT $3`,
        [auth.userId, params.data.noteId, query.data.limit ?? 100],
      );

      const entitlement = await getEntitlement(ctx.db, auth.userId, ctx.retention, ctx.now());
      const versions: RemoteVersionSnapshot[] = rows.map(toSnapshot);

      return reply.send({
        noteId: params.data.noteId,
        versions,
        retentionDays: entitlement.versionRetentionDays,
      });
    },
  );

  app.get(
    '/api/v1/vault/versions/:noteId/:versionId',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const auth = authOf(request);
      const params = versionParams.safeParse(request.params);
      if (!params.success || !isValidNoteId(params.data.noteId)) {
        throw errors.badRequest('bad_version_id');
      }

      const { rows } = await ctx.db.query<VersionRow>(
        `SELECT id, note_id, path, storage_key, etag, size, source, merged, taken_at, expires_at
           FROM versions
          WHERE user_id = $1 AND note_id = $2 AND id = $3 AND expires_at > now()`,
        [auth.userId, params.data.noteId, params.data.versionId],
      );
      const row = rows[0];
      if (row === undefined) throw errors.notFound('version_not_found');

      const bytes = await ctx.blobs.read(row.storage_key);
      if (bytes === null) throw errors.notFound('version_content_missing');

      return reply
        .header('etag', row.etag)
        .header('content-type', 'application/octet-stream')
        .header('cache-control', 'private, no-store')
        .header('x-version-taken-at', row.taken_at.toISOString())
        .header('x-version-source', encodeURIComponent(row.source))
        .header('x-version-merged', row.merged ? '1' : '0')
        .send(bytes);
    },
  );

  /**
   * Явный снимок. Клиент присылает зашифрованные байты версии; заголовки
   * X-Version-Source и X-Version-Merged заполняют поля `source` и `merged`
   * из `VersionSnapshot` (SCREENS §10b `4h` помечает автослияние иконкой).
   */
  app.post(
    '/api/v1/vault/versions/:noteId',
    { preHandler: app.requireAuth, bodyLimit: ctx.env.MAX_BLOB_BYTES },
    async (request, reply) => {
      const auth = authOf(request);
      const params = noteParams.safeParse(request.params);
      if (!params.success || !isValidNoteId(params.data.noteId)) {
        throw errors.badRequest('bad_note_id');
      }
      const data = requireBinaryBody(request);
      if (data.byteLength === 0) throw errors.badRequest('empty_version');
      if (data.byteLength > ctx.env.MAX_BLOB_BYTES) throw errors.blobTooLarge();

      await assertCanWrite(ctx, auth.userId);

      const rawPath = headerValue(request, 'x-vault-path');
      let vaultPath: string | null = null;
      if (rawPath !== undefined) {
        const normalized = normalizeVaultPath(rawPath);
        if (!normalized.ok) throw errors.badRequest(`bad_path_${normalized.reason}`);
        vaultPath = normalized.path;
      }

      const source = (headerValue(request, 'x-version-source') ?? 'local').slice(0, 120);
      const merged = headerValue(request, 'x-version-merged') === '1';

      const stored = await ctx.blobs.putContent(auth.userId, data);
      const entitlement = await getEntitlement(ctx.db, auth.userId, ctx.retention, ctx.now());
      const expiresAt = new Date(
        ctx.now().getTime() + entitlement.versionRetentionDays * 86_400_000,
      );

      const created = await withTransaction(ctx.db, async (client) => {
        const usage = await lockUsage(client, auth.userId);

        // Тот же шифротекст уже лежит под другой версией — место не тратим.
        const { rows: dup } = await client.query<{ exists: boolean }>(
          `SELECT true AS exists FROM versions WHERE user_id = $1 AND storage_key = $2 LIMIT 1`,
          [auth.userId, stored.storageKey],
        );
        const chargeable = dup.length > 0 ? 0 : stored.size;
        if (!fits(usage, chargeable, ctx.env.QUOTA_BYTES)) throw errors.quotaExceeded();

        const { rows } = await client.query<VersionRow>(
          `INSERT INTO versions
             (user_id, note_id, path, path_hash, storage_key, etag, size, source, merged, taken_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, note_id, path, storage_key, etag, size, source, merged, taken_at, expires_at`,
          [
            auth.userId,
            params.data.noteId,
            vaultPath,
            vaultPath === null ? null : shortHash(vaultPath),
            stored.storageKey,
            stored.etag,
            stored.size,
            source,
            merged,
            ctx.now(),
            expiresAt,
          ],
        );
        if (chargeable > 0) {
          await applyDelta(client, auth.userId, { bucket: 'version_bytes', bytes: chargeable });
        }
        const row = rows[0];
        if (row === undefined) throw errors.internal();
        return row;
      });

      return reply.code(201).send(toSnapshot(created));
    },
  );
}

function toSnapshot(row: VersionRow): RemoteVersionSnapshot {
  return {
    id: row.id,
    noteId: row.note_id,
    takenAt: row.taken_at.getTime(),
    source: row.source,
    merged: row.merged,
    size: row.size,
    etag: row.etag,
  };
}

/**
 * Уборка просроченных версий. Строку удаляем всегда, файл — только если на
 * него больше никто не ссылается.
 */
export async function pruneExpiredVersions(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const { rows } = await ctx.db.query<{ user_id: string; storage_key: string }>(
    `DELETE FROM versions WHERE expires_at < $1 RETURNING user_id, storage_key, size`,
    [now],
  );
  if (rows.length === 0) return 0;

  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.user_id} ${row.storage_key}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { rows: refs } = await ctx.db.query(
      `SELECT 1 FROM (
         SELECT 1 FROM blobs
           WHERE user_id = $1 AND storage_key = $2 AND deleted_at IS NULL
         UNION ALL
         SELECT 1 FROM versions WHERE user_id = $1 AND storage_key = $2
       ) refs LIMIT 1`,
      [row.user_id, row.storage_key],
    );
    if (refs.length === 0) await ctx.blobs.remove(row.storage_key);
  }

  // Счётчики после чистки проще пересчитать, чем вычитать по одной строке.
  const users = new Set(rows.map((r) => r.user_id));
  for (const userId of users) {
    await ctx.db.query(
      `UPDATE quota_usage q
          SET version_bytes = COALESCE(
                (SELECT SUM(size)::bigint FROM versions WHERE user_id = $1), 0),
              updated_at = now()
        WHERE q.user_id = $1`,
      [userId],
    );
  }

  return rows.length;
}
