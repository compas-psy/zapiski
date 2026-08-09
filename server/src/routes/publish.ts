import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.ts';
import { withTransaction } from '../db/pool.ts';
import { randomSlug, sha256Hex } from '../lib/crypto.ts';
import { errors } from '../lib/errors.ts';
import { isValidNoteId } from '../lib/vaultPath.ts';
import { sanitizeHtml } from '../lib/sanitizeHtml.ts';
import { authOf } from '../plugins/auth.ts';
import type { PublishedPageRef } from '../protocol.ts';
import { renderPublicPage, type PublicDocument } from '../views/publicPage.ts';
import { applyDelta, fits, lockUsage } from '../services/quota.ts';
import { assertCanWrite } from './vault.ts';

/**
 * Публикация по ссылке (ТЗ §5.3; в плане это P1, но API заложено сейчас).
 *
 * Сервер получает **уже отрендеренный клиентом HTML**: ключей у него нет, из
 * шифротекста markdown он отрендерить не может. Присланный HTML — недоверенный
 * ввод, поэтому проходит через белый список `sanitizeHtml`, а страница
 * отдаётся с CSP без `script-src`.
 *
 * Сам документ лежит в томе, а не в колонке БД: единственный открытый текст в
 * системе — тот, который пользователь опубликовал сам, и держать его в базе
 * рядом с зашифрованными данными незачем.
 */

const publishBody = z.object({
  html: z.string().min(1).max(4_000_000),
  title: z.string().trim().min(1).max(300),
  /** Лид — 19 secondary в макете `4j`. */
  lead: z.string().trim().max(600).optional(),
  noteId: z.string().optional(),
  /** Обновление уже опубликованной страницы по её слагу. */
  slug: z.string().regex(/^[a-z2-9]{6,32}$/).optional(),
  /** Дата в шапке страницы; по умолчанию — момент публикации. */
  publishedAt: z.string().datetime().optional(),
});

const slugParams = z.object({ slug: z.string().regex(/^[a-z2-9]{6,32}$/) });

interface PageRow {
  id: string;
  slug: string;
  storage_key: string;
  size: number;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

export async function registerPublishRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.post('/api/v1/publish', { preHandler: app.requireAuth, bodyLimit: ctx.env.MAX_PUBLISHED_BYTES }, async (request, reply) => {
    if (!ctx.env.PUBLISH_ENABLED) throw errors.publishDisabled();

    const parsed = publishBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_publish_payload');
    const auth = authOf(request);

    // SCREENS §9: публикация входит в ЗАПИСКИ+, значит это запись.
    await assertCanWrite(ctx, auth.userId);

    if (parsed.data.noteId !== undefined && !isValidNoteId(parsed.data.noteId)) {
      throw errors.badRequest('bad_note_id');
    }

    const sanitized = sanitizeHtml(parsed.data.html);
    if (sanitized.html.trim().length === 0) throw errors.badRequest('empty_html');

    const now = ctx.now();
    const document: PublicDocument = {
      title: parsed.data.title,
      lead: parsed.data.lead ?? null,
      html: sanitized.html,
      publishedAt: parsed.data.publishedAt ?? now.toISOString(),
    };
    const payload = Buffer.from(JSON.stringify(document), 'utf8');
    if (payload.byteLength > ctx.env.MAX_PUBLISHED_BYTES) throw errors.blobTooLarge();

    const slug = parsed.data.slug ?? randomSlug();
    const storageKey = ctx.blobs.keyForPublished(slug);

    const row = await withTransaction(ctx.db, async (client) => {
      const usage = await lockUsage(client, auth.userId);

      const { rows: existingRows } = await client.query<PageRow>(
        `SELECT id, slug, storage_key, size, created_at, updated_at, revoked_at
           FROM published_pages WHERE slug = $1 FOR UPDATE`,
        [slug],
      );
      const existing = existingRows[0];
      if (existing !== undefined) {
        // Чужой слаг не перезаписывается — иначе публикация становится
        // способом подменить чужую страницу.
        const { rows: owned } = await client.query(
          `SELECT 1 FROM published_pages WHERE id = $1 AND user_id = $2`,
          [existing.id, auth.userId],
        );
        if (owned.length === 0) throw errors.notFound('slug_taken');
      }

      const delta = payload.byteLength - (existing?.size ?? 0);
      if (!fits(usage, delta, ctx.env.QUOTA_BYTES)) throw errors.quotaExceeded();

      const { rows } = await client.query<PageRow>(
        `INSERT INTO published_pages (user_id, slug, storage_key, content_hash, size, note_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (slug) DO UPDATE
           SET storage_key = EXCLUDED.storage_key,
               content_hash = EXCLUDED.content_hash,
               size = EXCLUDED.size,
               note_id = EXCLUDED.note_id,
               revoked_at = NULL,
               updated_at = now()
         RETURNING id, slug, storage_key, size, created_at, updated_at, revoked_at`,
        [
          auth.userId,
          slug,
          storageKey,
          sha256Hex(payload),
          payload.byteLength,
          parsed.data.noteId ?? null,
        ],
      );
      await applyDelta(client, auth.userId, { bucket: 'published_bytes', bytes: delta });

      const created = rows[0];
      if (created === undefined) throw errors.internal();
      return created;
    });

    // Файл пишем после коммита: если запись упадёт, страница будет числиться,
    // но не отдастся — это лучше, чем отдавать содержимое без строки владельца.
    await ctx.blobs.writeAt(storageKey, payload);

    request.log.info(
      { event: 'page_published', slug, droppedNodes: sanitized.dropped },
      'страница опубликована',
    );

    const ref: PublishedPageRef = {
      slug: row.slug,
      url: publicUrl(ctx, row.slug),
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
      sizeBytes: row.size,
    };
    return reply.code(201).send(ref);
  });

  app.get('/api/v1/publish', { preHandler: app.requireAuth }, async (request, reply) => {
    const auth = authOf(request);
    const { rows } = await ctx.db.query<PageRow>(
      `SELECT id, slug, storage_key, size, created_at, updated_at, revoked_at
         FROM published_pages
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 500`,
      [auth.userId],
    );
    const pages: PublishedPageRef[] = rows.map((row) => ({
      slug: row.slug,
      url: publicUrl(ctx, row.slug),
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
      sizeBytes: row.size,
    }));
    return reply.send({ pages });
  });

  /** Снятие публикации. Разрешено всегда: это уборка, а не запись. */
  app.delete('/api/v1/publish/:slug', { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) throw errors.badRequest('bad_slug');
    const auth = authOf(request);

    const removed = await withTransaction(ctx.db, async (client) => {
      await lockUsage(client, auth.userId);
      const { rows } = await client.query<PageRow>(
        `UPDATE published_pages
            SET revoked_at = now(), updated_at = now()
          WHERE slug = $1 AND user_id = $2 AND revoked_at IS NULL
          RETURNING id, slug, storage_key, size, created_at, updated_at, revoked_at`,
        [parsed.data.slug, auth.userId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      await applyDelta(client, auth.userId, { bucket: 'published_bytes', bytes: -row.size });
      return row;
    });

    if (removed === null) throw errors.notFound('page_not_found');
    await ctx.blobs.remove(removed.storage_key);
    return reply.code(204).send();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Публичная страница (SCREENS §10b `4j`)
  // ───────────────────────────────────────────────────────────────────────────

  app.get('/p/:slug', async (request, reply) => {
    const parsed = slugParams.safeParse(request.params);
    if (!parsed.success) return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());

    const { rows } = await ctx.db.query<PageRow>(
      `SELECT id, slug, storage_key, size, created_at, updated_at, revoked_at
         FROM published_pages WHERE slug = $1 AND revoked_at IS NULL`,
      [parsed.data.slug],
    );
    const row = rows[0];
    if (row === undefined) {
      return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());
    }

    const raw = await ctx.blobs.read(row.storage_key);
    if (raw === null) {
      return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());
    }

    let document: PublicDocument;
    try {
      document = JSON.parse(raw.toString('utf8')) as PublicDocument;
    } catch {
      return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());
    }

    return reply
      .type('text/html; charset=utf-8')
      // Второй слой защиты: script-src в политике отсутствует вовсе, поэтому
      // при default-src 'none' скрипт не выполнится, даже если просочится
      // через санитайзер.
      .header(
        'content-security-policy',
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=60')
      .send(renderPublicPage(document));
  });
}

function publicUrl(ctx: AppContext, slug: string): string {
  return `${ctx.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/p/${slug}`;
}

/** Тон реестра §11: спокойно, без «ошибка» и без призывов. */
function notFoundPage(): string {
  return renderPublicPage({
    title: 'Страницы нет',
    lead: 'Возможно, публикацию сняли.',
    html: '',
    publishedAt: new Date().toISOString(),
  });
}
