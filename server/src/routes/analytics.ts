import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.ts';
import { errors } from '../lib/errors.ts';
import { analyticsBatchBody } from '../lib/analytics-schema.ts';
import { authOf } from '../plugins/auth.ts';
import { findUserById } from '../services/accounts.ts';
import type { PracticeEnvelope } from '../services/practiceBridge.ts';
import { markPracticeForwardResults } from '../services/practiceForwardMarks.ts';

/**
 * Приём событий продуктовой аналитики (ТЗ §6, O-260817-05).
 *
 * Четыре независимых замка, каждый обязателен сам по себе:
 *  1. `ANALYTICS_ENABLED` — фича-флаг, выключен по умолчанию (docs/dev/modules/server.md).
 *  2. `users.analytics_opt_in` — согласие конкретного человека, проверяется
 *     на КАЖДЫЙ запрос, а не один раз при выдаче токена: отозвал — сервер
 *     перестаёт принимать немедленно, а не только клиент перестаёт слать.
 *  3. `analyticsBatchBody` — `.strict()`-схема на каждое поле события: лишнее
 *     поле, которым можно было бы протащить текст заметки, роняет весь
 *     батч `400`, а не откладывается в сторону молча.
 *  4. `ON CONFLICT (event_id) DO NOTHING` — идемпотентность (Д-6, C3): та же
 *     пачка, отправленная повторно после ретрая или потерянного ответа, не
 *     задваивает счётчики. `event_id` стабилен на клиенте (генерируется при
 *     постановке в очередь, не при отправке), уникальный индекс — на приёме.
 *
 * Пересылка в ПРАКТИКУ (C4, `charter/12_ANALYTICS.md §3`, доведена контрактом
 * контура v2 — E-Z2) — ПОСЛЕ того, как событие уже сохранено у ЗАПИСОК, и
 * НИКОГДА не влияет на ответ этому маршруту: приём ЗАПИСОК не зависит от
 * доступности ПРАКТИКИ. Пересылается только то, что реально ВСТАВЛЕНО
 * (`RETURNING id` — пусто на конфликте по `event_id`): повторно отправленный
 * дубликат уже был переслан (или ждёт sweep'а) при первой вставке, пересылать
 * его снова значило бы задваивать строку на стороне ПРАКТИКИ.
 *
 * Все реально вставленные строки этого запроса пересылаются ОДНИМ вызовом
 * `forwardBatch` (не по одному HTTP-запросу на событие в цикле, как было
 * раньше). Раньше здесь стояло, что входящий батч всегда укладывается в один
 * сетевой запрос к ПРАКТИКЕ, потому что оба предела равны 200. Это перестало
 * быть правдой: приём согласен взять до `MAX_EVENTS_ACCEPTED_PER_REQUEST`
 * (500) ради уже установленных сборок, чья очередь режет по 500. На
 * поведение это не влияет — `forwardBatch` сам режет пересылку по пределу
 * приёмника, — но утверждение «всегда один запрос» больше не действует.
 */
export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  const ctx: AppContext = app.ctx;

  app.post('/api/v1/analytics/events', { preHandler: app.requireAuth }, async (request, reply) => {
    if (!ctx.env.ANALYTICS_ENABLED) throw errors.analyticsDisabled();

    const auth = authOf(request);
    const user = await findUserById(ctx.db, auth.userId);
    if (user === null || !user.analytics_opt_in) throw errors.analyticsDisabled();

    const parsed = analyticsBatchBody.safeParse(request.body);
    if (!parsed.success) throw errors.badRequest('bad_analytics_event');

    const insertedIds: number[] = [];
    const insertedEnvelopes: PracticeEnvelope[] = [];

    for (const event of parsed.data.events) {
      // `eventId` необязателен на приёме ради уже установленных сборок
      // (Windows, macOS, Android), собранных до появления этого поля —
      // подробное объяснение в analytics-schema.ts. Колонка в базе NOT NULL,
      // значит значение всё равно нужно: выдаём своё. Идемпотентности оно не
      // даёт (при повторной доставке родится другое, и событие задвоится —
      // ровно как задваивалось до введения ключа), но событие ПРИНИМАЕТСЯ, а
      // не отвергается. Тот же самый id уходит и в конверт для ПРАКТИКИ ниже:
      // иначе её дедупликация работала бы по одному значению, а наша — по
      // другому, и повтор пересылки задвоил бы строку уже у неё.
      const effectiveEventId = event.eventId ?? randomUUID();

      const inserted = await ctx.db.query<{ id: number }>(
        `INSERT INTO analytics_events (user_id, event, props, client_ts, event_id, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [auth.userId, event.event, JSON.stringify(event.props), event.ts, effectiveEventId, event.schemaVersion],
      );
      const row = inserted.rows[0];
      if (row === undefined) continue;
      insertedIds.push(row.id);
      insertedEnvelopes.push({
        event: event.event,
        ts: event.ts,
        product: 'zapiski',
        account_id: auth.userId,
        device_id: null,
        props: event.props,
        schema_version: event.schemaVersion,
        event_id: effectiveEventId,
      });
    }

    // Пересылка не должна ломать приём (ТЗ этого узла): отказ моста ловится
    // здесь же и не превращается в ошибку ответа. Не дошедшее (outcome
    // `error`) подхватит sweep (`retryPracticeForwarding`) по
    // `practice_forwarded_at IS NULL`; явно отвергнутое (`rejected`, чаще
    // всего — согласие субъекта ещё не на файле у ПРАКТИКИ) получает
    // `practice_reject_reason`, а не тихую вечную непереслaнность без следа.
    if (insertedEnvelopes.length > 0 && ctx.practiceBridge !== null) {
      const results = await ctx.practiceBridge.forwardBatch(insertedEnvelopes).catch(() =>
        insertedEnvelopes.map(() => ({ outcome: 'error' as const })),
      );
      await markPracticeForwardResults(ctx.db, insertedIds, results).catch(() => undefined);
    }

    return reply.send({ accepted: parsed.data.events.length });
  });
}
