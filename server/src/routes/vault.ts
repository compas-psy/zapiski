import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { withTransaction, type DbClient } from '../db/pool.ts';
import { normalizeEtag, sha256Hex, shortHash } from '../lib/crypto.ts';
import { errors } from '../lib/errors.ts';
import { isValidNoteId, logPath, normalizeVaultPath } from '../lib/vaultPath.ts';
import { authOf } from '../plugins/auth.ts';
import type {
  BlobWriteResult,
  CrdtUpdateEnvelope,
  ManifestResponse,
  RemoteEntry,
} from '../protocol.ts';
import { applyDelta, fits, lockUsage, quotaStatus } from '../services/quota.ts';
import { getEntitlement } from '../services/subscription.ts';

/**
 * E2E blob-синк (ТЗ §4.1, ZapiskiCloud).
 *
 * Сервер — «тупая труба» для зашифрованных чанков: он не знает, что внутри
 * байтов, и не пытается узнать. Всё, чем он управляет, — метаданные: путь,
 * etag, размер, время.
 *
 * Правило доступа (ТЗ §5.5): **чтение доступно всегда**. Ни один GET здесь не
 * спрашивает про подписку. Истёкшая подписка запрещает только запись.
 */

interface BlobRow {
  id: string;
  path: string;
  etag: string;
  size: number;
  mtime: number;
  storage_key: string;
  deleted_at: Date | null;
}

const manifestQuery = z.object({
  /** Отдать только изменённое позже указанного mtime (мс эпохи). */
  since: z.coerce.number().int().nonnegative().optional(),
  /** Включить надгробия удалённых путей — для досинхронизации удалений. */
  includeDeleted: z.enum(['0', '1']).optional(),
});

const crdtPostParams = z.object({ noteId: z.string() });
const crdtGetQuery = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export async function registerVaultRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  // ───────────────────────────────────────────────────────────────────────────
  // Манифест
  // ───────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/vault/manifest', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const parsed = manifestQuery.safeParse(request.query);
    if (!parsed.success) throw errors.badRequest('bad_manifest_query');

    const includeDeleted = parsed.data.includeDeleted === '1';
    const since = parsed.data.since ?? 0;

    const { rows } = await ctx.db.query<{
      path: string;
      etag: string;
      mtime: number;
      size: number;
      deleted_at: Date | null;
    }>(
      `SELECT path, etag, mtime, size, deleted_at
         FROM blobs
        WHERE user_id = $1
          AND mtime > $2
          AND ($3 OR deleted_at IS NULL)
        ORDER BY path`,
      [auth.userId, since, includeDeleted],
    );

    const entries: RemoteEntry[] = rows
      .filter((row) => includeDeleted || row.deleted_at === null)
      .map((row) => ({ path: row.path, etag: row.etag, mtime: row.mtime, size: row.size }));

    const body: ManifestResponse = {
      entries,
      quota: await quotaStatus(ctx.db, auth.userId, ctx.env.QUOTA_BYTES),
    };

    if (includeDeleted) {
      const removed = rows.filter((row) => row.deleted_at !== null).map((row) => row.path);
      return reply.send({ ...body, removed });
    }
    return reply.send(body);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Блобы
  // ───────────────────────────────────────────────────────────────────────────

  app.get('/api/v1/vault/blob/*', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const vaultPath = requirePath(request);

    const row = await selectBlob(ctx, auth.userId, vaultPath);
    if (row === null || row.deleted_at !== null) throw errors.notFound('blob_not_found');

    // Условный GET: клиент уже держит эту версию.
    const ifNoneMatch = headerValue(request, 'if-none-match');
    if (ifNoneMatch !== undefined && matchesEtag(ifNoneMatch, row.etag)) {
      return reply.code(304).header('etag', row.etag).send();
    }

    const bytes = await ctx.blobs.read(row.storage_key);
    if (bytes === null) {
      // Строка есть, файла нет — это порча тома, а не отсутствие данных.
      request.log.error(
        { event: 'blob_file_missing', path: logPath(vaultPath) },
        'файл блоба не найден в томе',
      );
      throw errors.notFound('blob_content_missing');
    }

    return reply
      .header('etag', row.etag)
      .header('last-modified', new Date(row.mtime).toUTCString())
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'private, no-store')
      .send(bytes);
  });

  app.put(
    '/api/v1/vault/blob/*',
    { preHandler: app.requireAuth, bodyLimit: ctx.env.MAX_BLOB_BYTES },
    async (request, reply) => {
      const auth = authOf(request);
      const vaultPath = requirePath(request);
      const data = requireBinaryBody(request);

      if (data.byteLength > ctx.env.MAX_BLOB_BYTES) throw errors.blobTooLarge();

      // ТЗ §5.5: писать может только действующая подписка. Читать — все.
      await assertCanWrite(ctx, auth.userId);

      const ifMatch = headerValue(request, 'if-match');
      const ifNoneMatch = headerValue(request, 'if-none-match');
      const noteId = headerValue(request, 'x-note-id');
      const mtime = ctx.now().getTime();

      // Адрес содержимого считаем заранее, а на диск пишем уже внутри
      // транзакции — после проверок If-Match и квоты. Иначе отказ по квоте
      // всё равно оставлял бы байты в томе, и упереться в лимит означало бы
      // «можно бесконечно занимать место отклонёнными запросами».
      const stored = await ctx.blobs.describeContent(auth.userId, data);

      const result = await withTransaction(ctx.db, async (client) => {
        const usage = await lockUsage(client, auth.userId);
        const existing = await selectBlobForUpdate(client, auth.userId, vaultPath);
        const live = existing !== null && existing.deleted_at === null;

        // Оптимистичная блокировка (SyncBackend.put(..., ifMatch)).
        if (ifMatch !== undefined) {
          if (!live) throw errors.etagMismatch();
          if (ifMatch.trim() !== '*' && !matchesEtag(ifMatch, existing.etag)) {
            throw errors.etagMismatch();
          }
        }
        if (ifNoneMatch !== undefined && ifNoneMatch.trim() === '*' && live) {
          throw errors.etagMismatch();
        }

        const previousSize = live ? existing.size : 0;
        const deltaBytes = stored.size - previousSize;
        if (!fits(usage, deltaBytes, ctx.env.QUOTA_BYTES)) throw errors.quotaExceeded();

        // Снимок предыдущего шифротекста в историю версий (ТЗ §4.2).
        // Байты не копируются: адресация по содержимому, ключ тот же.
        let versionBytes = 0;
        if (live && noteId !== undefined && isValidNoteId(noteId) && existing.etag !== stored.etag) {
          versionBytes = await snapshotVersion(ctx, client, {
            userId: auth.userId,
            noteId,
            vaultPath,
            row: existing,
            source: headerValue(request, 'x-device-name') ?? 'cloud',
            merged: headerValue(request, 'x-version-merged') === '1',
          });
        }

        // Проверки пройдены — кладём байты. Содержимое адресуется хешем,
        // поэтому запись ничего не затирает: при откате транзакции остаётся
        // файл, на который никто не ссылается, а не испорченная версия.
        await ctx.blobs.putContent(auth.userId, data);

        await client.query(
          `INSERT INTO blobs (user_id, path, path_hash, etag, size, mtime, storage_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, path) DO UPDATE
             SET etag = EXCLUDED.etag,
                 size = EXCLUDED.size,
                 mtime = EXCLUDED.mtime,
                 storage_key = EXCLUDED.storage_key,
                 deleted_at = NULL,
                 updated_at = now()`,
          [
            auth.userId,
            vaultPath,
            shortHash(vaultPath),
            stored.etag,
            stored.size,
            mtime,
            stored.storageKey,
          ],
        );

        await applyDelta(client, auth.userId, {
          bucket: 'blob_bytes',
          bytes: deltaBytes,
          blobCountDelta: live ? 0 : 1,
        });
        if (versionBytes > 0) {
          await applyDelta(client, auth.userId, { bucket: 'version_bytes', bytes: versionBytes });
        }

        return { previousKey: live ? existing.storage_key : null };
      });

      // Старый шифротекст сносим только после коммита и только если на него
      // никто больше не ссылается (ни блоб, ни версия).
      if (result.previousKey !== null && result.previousKey !== stored.storageKey) {
        await dropUnreferencedContent(ctx, auth.userId, result.previousKey);
      }

      ctx.live.publish(auth.userId, {
        type: 'changed',
        path: vaultPath,
        etag: stored.etag,
        mtime,
        origin: auth.deviceId,
      });

      const body: BlobWriteResult = {
        path: vaultPath,
        etag: stored.etag,
        mtime,
        size: stored.size,
      };
      return reply.code(200).header('etag', stored.etag).send(body);
    },
  );

  app.delete('/api/v1/vault/blob/*', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const vaultPath = requirePath(request);
    const ifMatch = headerValue(request, 'if-match');

    // Удаление разрешено и после истечения подписки: иначе пользователь,
    // упёршийся в квоту, оказывается заперт без выхода. ТЗ §5.5 запрещает
    // «запись новых» данных, а не уборку своих.
    const removed = await withTransaction(ctx.db, async (client) => {
      await lockUsage(client, auth.userId);
      const existing = await selectBlobForUpdate(client, auth.userId, vaultPath);
      if (existing === null || existing.deleted_at !== null) return null;

      if (ifMatch !== undefined && ifMatch.trim() !== '*' && !matchesEtag(ifMatch, existing.etag)) {
        throw errors.etagMismatch();
      }

      await client.query(
        `UPDATE blobs SET deleted_at = now(), size = 0, mtime = $3, updated_at = now()
          WHERE id = $1 AND user_id = $2`,
        [existing.id, auth.userId, ctx.now().getTime()],
      );
      await applyDelta(client, auth.userId, {
        bucket: 'blob_bytes',
        bytes: -existing.size,
        blobCountDelta: -1,
      });
      return existing.storage_key;
    });

    if (removed === null) throw errors.notFound('blob_not_found');

    await dropUnreferencedContent(ctx, auth.userId, removed);
    ctx.live.publish(auth.userId, { type: 'removed', path: vaultPath, origin: auth.deviceId });

    return reply.code(204).send();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CRDT-апдейты: сервер складывает и отдаёт, но не интерпретирует
  // ───────────────────────────────────────────────────────────────────────────

  app.post(
    '/api/v1/vault/crdt/:noteId',
    { preHandler: app.requireAuth, bodyLimit: ctx.env.MAX_CRDT_BYTES },
    async (request, reply) => {
      const auth = authOf(request);
      const params = crdtPostParams.safeParse(request.params);
      if (!params.success || !isValidNoteId(params.data.noteId)) {
        throw errors.badRequest('bad_note_id');
      }
      const noteId = params.data.noteId;
      const updates = requireCrdtUpdates(request);
      if (updates.length === 0) throw errors.badRequest('empty_update');

      await assertCanWrite(ctx, auth.userId);

      const totalBytes = updates.reduce((sum, u) => sum + u.byteLength, 0);
      if (totalBytes > ctx.env.MAX_CRDT_BYTES) throw errors.blobTooLarge();

      const seq = await withTransaction(ctx.db, async (client) => {
        const usage = await lockUsage(client, auth.userId);
        if (!fits(usage, totalBytes, ctx.env.QUOTA_BYTES)) throw errors.quotaExceeded();

        let last = 0;
        for (const update of updates) {
          const { rows } = await client.query<{ seq: number }>(
            `INSERT INTO crdt_updates (user_id, note_id, ciphertext, size, device_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING seq`,
            [auth.userId, noteId, Buffer.from(update), update.byteLength, auth.deviceId],
          );
          last = rows[0]?.seq ?? last;
        }
        await applyDelta(client, auth.userId, { bucket: 'crdt_bytes', bytes: totalBytes });
        return last;
      });

      ctx.live.publish(auth.userId, { type: 'crdt', noteId, seq, origin: auth.deviceId });
      return reply.code(201).send({ noteId, seq, accepted: updates.length });
    },
  );

  app.get('/api/v1/vault/crdt/:noteId', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const params = crdtPostParams.safeParse(request.params);
    if (!params.success || !isValidNoteId(params.data.noteId)) {
      throw errors.badRequest('bad_note_id');
    }
    const query = crdtGetQuery.safeParse(request.query);
    if (!query.success) throw errors.badRequest('bad_since');

    const since = query.data.since ?? 0;
    const limit = query.data.limit ?? 500;

    const { rows } = await ctx.db.query<{
      seq: number;
      ciphertext: Buffer;
      created_at: Date;
    }>(
      `SELECT seq, ciphertext, created_at
         FROM crdt_updates
        WHERE user_id = $1 AND note_id = $2 AND seq > $3
        ORDER BY seq
        LIMIT $4`,
      [auth.userId, params.data.noteId, since, limit],
    );

    const updates: CrdtUpdateEnvelope[] = rows.map((row) => ({
      seq: row.seq,
      noteId: params.data.noteId,
      update: row.ciphertext.toString('base64'),
      createdAt: row.created_at.getTime(),
    }));

    return reply.send({
      updates,
      nextSince: updates.at(-1)?.seq ?? since,
      hasMore: updates.length === limit,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Общие помощники — их же переиспользуют маршруты версий
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ТЗ §5.5: писать может только действующая подписка; читать — все.
 *
 * Пока оплата выключена (`BILLING_ENABLED=false`), `canWrite` истинно у
 * каждого вошедшего, и до отказа дело не доходит вовсе.
 *
 * Если оплату включат, отказ обязан называть вещи своими именами: тому, у
 * кого подписки не было ни разу, «Подписка закончилась» сообщает о событии,
 * которого не происходило. Поэтому текст выбирается по состоянию, а не один
 * на оба случая.
 */
export async function assertCanWrite(ctx: AppContext, userId: string): Promise<void> {
  const entitlement = await getEntitlement(
    ctx.db,
    userId,
    ctx.retention,
    ctx.env.BILLING_ENABLED,
    ctx.now(),
  );
  if (entitlement.canWrite) return;
  throw entitlement.status === 'expired'
    ? errors.subscriptionExpired()
    : errors.subscriptionRequired();
}

export function requirePath(request: FastifyRequest): string {
  const params = request.params as Record<string, unknown>;
  const raw = params['*'];
  if (typeof raw !== 'string') throw errors.badRequest('path_required');
  const normalized = normalizeVaultPath(raw);
  if (!normalized.ok) throw errors.badRequest(`bad_path_${normalized.reason}`);
  return normalized.path;
}

export function requireBinaryBody(request: FastifyRequest): Buffer {
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw errors.badRequest('binary_body_required');
}

/**
 * CRDT-апдейт можно прислать сырыми байтами (`application/octet-stream`) или
 * пачкой в JSON: `{"updates": ["<base64>", ...]}`. Второе экономит запросы,
 * когда клиент досылает накопленный оффлайн-хвост.
 */
function requireCrdtUpdates(request: FastifyRequest): Uint8Array[] {
  const body = request.body;
  if (Buffer.isBuffer(body)) return body.byteLength === 0 ? [] : [body];

  const parsed = z
    .object({
      update: z.string().optional(),
      updates: z.array(z.string()).max(500).optional(),
    })
    .safeParse(body);
  if (!parsed.success) throw errors.badRequest('binary_body_required');

  const encoded = parsed.data.updates ?? (parsed.data.update !== undefined ? [parsed.data.update] : []);
  return encoded.map((value) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.byteLength === 0) throw errors.badRequest('empty_update');
    return bytes;
  });
}

export function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** Сравнение If-Match / If-None-Match со списком значений. */
export function matchesEtag(header: string, etag: string): boolean {
  return header
    .split(',')
    .map((part) => normalizeEtag(part))
    .some((candidate) => candidate === etag);
}

async function selectBlob(
  ctx: AppContext,
  userId: string,
  vaultPath: string,
): Promise<BlobRow | null> {
  const { rows } = await ctx.db.query<BlobRow>(
    `SELECT id, path, etag, size, mtime, storage_key, deleted_at
       FROM blobs WHERE user_id = $1 AND path = $2`,
    [userId, vaultPath],
  );
  return rows[0] ?? null;
}

async function selectBlobForUpdate(
  client: DbClient,
  userId: string,
  vaultPath: string,
): Promise<BlobRow | null> {
  const { rows } = await client.query<BlobRow>(
    `SELECT id, path, etag, size, mtime, storage_key, deleted_at
       FROM blobs WHERE user_id = $1 AND path = $2 FOR UPDATE`,
    [userId, vaultPath],
  );
  return rows[0] ?? null;
}

interface SnapshotInput {
  userId: string;
  noteId: string;
  vaultPath: string;
  row: BlobRow;
  source: string;
  merged: boolean;
}

/**
 * Кладёт строку версии на предыдущий шифротекст. Возвращает, сколько байт
 * добавилось к учёту: если тот же ключ уже числится за другой версией,
 * место второй раз не занимается.
 */
async function snapshotVersion(
  ctx: AppContext,
  client: DbClient,
  input: SnapshotInput,
): Promise<number> {
  const entitlement = await getEntitlement(
    client,
    input.userId,
    ctx.retention,
    ctx.env.BILLING_ENABLED,
    ctx.now(),
  );
  const expiresAt = new Date(
    ctx.now().getTime() + entitlement.versionRetentionDays * 86_400_000,
  );

  const { rows: already } = await client.query<{ exists: boolean }>(
    `SELECT true AS exists FROM versions WHERE user_id = $1 AND storage_key = $2 LIMIT 1`,
    [input.userId, input.row.storage_key],
  );

  await client.query(
    `INSERT INTO versions
       (user_id, note_id, path, path_hash, storage_key, etag, size, source, merged, taken_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      input.userId,
      input.noteId,
      input.vaultPath,
      shortHash(input.vaultPath),
      input.row.storage_key,
      input.row.etag,
      input.row.size,
      input.source.slice(0, 120),
      input.merged,
      new Date(input.row.mtime),
      expiresAt,
    ],
  );

  return already.length > 0 ? 0 : input.row.size;
}

/**
 * Удаляет файл из тома, если на его ключ больше нет ссылок. Вызывается только
 * после коммита: пока транзакция не зафиксирована, ссылка может воскреснуть.
 */
export async function dropUnreferencedContent(
  ctx: AppContext,
  userId: string,
  storageKey: string,
): Promise<void> {
  const { rows } = await ctx.db.query<{ exists: boolean }>(
    `SELECT true AS exists FROM (
       SELECT 1 FROM blobs
         WHERE user_id = $1 AND storage_key = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT 1 FROM versions WHERE user_id = $1 AND storage_key = $2
     ) refs LIMIT 1`,
    [userId, storageKey],
  );
  if (rows.length > 0) return;
  await ctx.blobs.remove(storageKey);
}

/** Хеш содержимого — вынесен, чтобы тесты могли проверить формат etag. */
export function contentEtag(data: Uint8Array): string {
  return `"${Buffer.from(sha256Hex(data), 'hex').toString('base64url')}"`;
}
