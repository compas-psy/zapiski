/**
 * Обращения из беты: приём с устройства и выдача для разбора.
 *
 * ── Две ручки с разными правами ─────────────────────────────────────────────
 *
 * `POST /api/v1/feedback` — публичная и без аутентификации. Иначе форма не
 * работала бы у того, у кого нет аккаунта, а это большинство: приложение
 * локальное, аккаунт нужен только для облака.
 *
 * `GET /api/v1/feedback?since=` — только по сервисному токену. Это ручка
 * ночного цикла, и наружу она не открывается: в ней лежат тексты живых людей.
 * Токена нет в окружении — ручка отвечает отказом ВСЕГДА, а не «пускает всех»:
 * забытая настройка не должна превращаться в открытую дверь.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { errors } from '../lib/errors.ts';

/** Потолок обращения без скриншота. Столько текста человек не напишет. */
const MAX_TEXT = 8_000;
/** Скриншот в base64. Полтора мегабайта — снимок экрана телефона с запасом. */
const MAX_SCREENSHOT = 1_500_000;

/**
 * Схема тела. Строгая: `strict()` отвергает лишние ключи целиком.
 *
 * Это не педантизм. Лишний ключ в обращении — самый вероятный способ, каким
 * однажды приедет содержимое заметки: кто-то добавит «последнее действие»
 * строкой, и оно молча ляжет в базу. Отказ виден сразу, тихое сохранение — нет.
 */
const contextSchema = z
  .object({
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/).optional(),
    lastAction: z
      .enum(['search', 'sync', 'import', 'export', 'edit', 'open', 'attach'])
      .optional(),
    conflict: z.enum(['merged', 'both-kept', 'encrypted']).optional(),
    devices: z.number().int().min(0).max(1000).optional(),
    durationMs: z.number().int().min(0).optional(),
  })
  .strict();

const diagnosticsSchema = z
  .object({
    version: z.string().max(40).optional(),
    platform: z.enum(['web', 'windows', 'android']).optional(),
    locale: z.enum(['ru', 'en']).optional(),
    notes: z.enum(['<100', '100-500', '500+']).optional(),
    encryption: z.boolean().optional(),
    errorCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/)).max(10).optional(),
    daysSinceInstall: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export const feedbackBody = z
  .object({
    id: z.string().uuid(),
    createdAt: z.number().int().positive(),
    kind: z.enum(['broken', 'awkward', 'want-feature', 'other']),
    text: z.string().min(1).max(MAX_TEXT),
    contact: z.string().max(200).optional(),
    entry: z.enum(['menu', 'error', 'sync_conflict', 'slow_op']),
    context: contextSchema.optional(),
    diagnostics: diagnosticsSchema.optional(),
    screenshot: z.string().max(MAX_SCREENSHOT).optional(),
  })
  .strict();

export type FeedbackBody = z.infer<typeof feedbackBody>;

/**
 * Пускать ли к выдаче обращений.
 *
 * Вынесено функцией и покрыто тестом без базы: именно здесь ошибка стоила бы
 * дороже всего, а тесты с Postgres в части окружений пропускаются. Правило:
 * токен в окружении не задан — не пускаем никого.
 */
export function serviceTokenAccepted(expected: string | undefined, header: unknown): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const given = header.slice(prefix.length);
  /* Сравнение постоянного времени: длина токена и так известна, а посимвольная
     утечка времени — известный способ подобрать секрет по одному байту. */
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function registerFeedbackRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;

  app.post('/api/v1/feedback', async (request, reply) => {
    const parsed = feedbackBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('feedback_malformed');
    const report = parsed.data;

    const screenshot =
      report.screenshot === undefined ? null : Buffer.from(report.screenshot, 'base64');

    /*
     * `ON CONFLICT DO NOTHING` — идемпотентность досылки. Ответ одинаковый и
     * на первую вставку, и на повтор: клиенту незачем знать, дошло ли раньше,
     * ему важно, что дошло.
     */
    await ctx.db.query(
      `INSERT INTO feedback (id, created_at, kind, body, contact, entry, context, diagnostics, screenshot)
         VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        report.id,
        report.createdAt,
        report.kind,
        report.text,
        report.contact ?? null,
        report.entry,
        report.context === undefined ? null : JSON.stringify(report.context),
        report.diagnostics === undefined ? null : JSON.stringify(report.diagnostics),
        screenshot,
      ],
    );

    /* 202, а не 201: «принято». Обращение могло уже лежать в базе, и создание
       ресурса тут обещать нечего. */
    return reply.code(202).send({ status: 'accepted' });
  });

  app.get('/api/v1/feedback', async (request, reply) => {
    if (!serviceTokenAccepted(ctx.env.FEEDBACK_SERVICE_TOKEN, request.headers.authorization)) {
      throw errors.authRequired();
    }

    const query = z
      .object({ since: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(request.query);
    if (!query.success) throw errors.badRequest('feedback_bad_query');

    const since = query.data.since;
    const limit = query.data.limit ?? 100;
    const rows = await ctx.db.query<{
      id: string;
      created_at: Date;
      received_at: Date;
      kind: string;
      body: string;
      contact: string | null;
      entry: string;
      context: unknown;
      diagnostics: unknown;
      has_screenshot: boolean;
      status: string;
    }>(
      `SELECT id, created_at, received_at, kind, body, contact, entry, context, diagnostics,
              screenshot IS NOT NULL AS has_screenshot, status
         FROM feedback
        WHERE ($1::timestamptz IS NULL OR received_at > $1::timestamptz)
        ORDER BY received_at ASC
        LIMIT $2`,
      [since ?? null, limit],
    );

    return reply.send({
      items: rows.rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        kind: row.kind,
        text: row.body,
        contact: row.contact,
        entry: row.entry,
        context: row.context,
        diagnostics: row.diagnostics,
        /* Сам снимок не отдаём: он тяжёлый и его смотрят отдельно. */
        hasScreenshot: row.has_screenshot,
        status: row.status,
      })),
    });
  });
}
