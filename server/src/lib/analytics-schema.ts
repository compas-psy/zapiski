/**
 * Реестр событий аналитики — серверная сторона (O-260817-05,
 * `analytics/schema/events.yaml`). Сервер не зависит от `@zapiski/core`
 * (отдельный деплой), поэтому whitelist продублирован здесь; в согласии со
 * стороной клиента (`packages/core/src/analytics/schema.ts`) и с реестром
 * держит `test/analytics.events.test.ts`.
 *
 * `.strict()` у каждой схемы — это и есть защита правила 2
 * (charter/12_ANALYTICS.md §1, «содержание не измеряется никогда»): лишнее
 * поле, которым можно было бы протащить текст, роняет валидацию целиком, а
 * не просто игнорируется.
 */
import { z } from 'zod';

const lengthBucket = z.enum(['xs', 's', 'm', 'l', 'xl']);
const nonNegativeInt = z.number().int().nonnegative();

/**
 * Версия реестра, в котором клиент собрал событие (Д-4, `12_ANALYTICS.md §3`
 * — поле `schema_version` единого конверта контура).
 *
 * `buildAnalyticsEvent` (`packages/core/src/analytics/schema.ts:58,90`)
 * кладёт это поле в КАЖДЫЙ конверт без исключения — оно не опциональное на
 * клиенте, и здесь не может быть опциональным тоже. До этой правки схема его
 * не знала: `.strict()` видел лишнее поле и валил весь батч `400`, поэтому
 * ни одно настоящее событие ЗАПИСОК не проходило приёмник (см. сообщение
 * коммита). Значение не сверяется с конкретной цифрой реестра — сервер не
 * обязан знать номер версии клиента заранее, только то, что версия названа.
 */
const schemaVersion = z.number().int().positive();

const noteSaved = z
  .object({
    event: z.literal('note_saved'),
    ts: z.string().datetime(),
    props: z.object({ length_bucket: lengthBucket, encrypted: z.boolean() }).strict(),
    schemaVersion,
  })
  .strict();

const noteSearched = z
  .object({
    event: z.literal('note_searched'),
    ts: z.string().datetime(),
    props: z.object({ query_length_bucket: lengthBucket, results_count: nonNegativeInt }).strict(),
    schemaVersion,
  })
  .strict();

const syncCompleted = z
  .object({
    event: z.literal('sync_completed'),
    ts: z.string().datetime(),
    props: z
      .object({ pushed: nonNegativeInt, pulled: nonNegativeInt, conflicts: nonNegativeInt })
      .strict(),
    schemaVersion,
  })
  .strict();

const exportRequested = z
  .object({
    event: z.literal('export_requested'),
    ts: z.string().datetime(),
    props: z
      .object({ format: z.enum(['md', 'html', 'docx', 'pdf', 'zip']), notes_count: nonNegativeInt })
      .strict(),
    schemaVersion,
  })
  .strict();

export const analyticsEventSchema = z.discriminatedUnion('event', [
  noteSaved,
  noteSearched,
  syncCompleted,
  exportRequested,
]);

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/** Одна отправка — не безлимитная: очередь на клиенте копится офлайн, но не бесконечно (`AnalyticsQueue`, лимит 500). */
export const MAX_EVENTS_PER_REQUEST = 200;

export const analyticsBatchBody = z.object({
  events: z.array(analyticsEventSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
});
