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

/**
 * Ключ идемпотентности приёма (Д-6, C3, `12_ANALYTICS.md §3` — `event_id`
 * единого конверта контура).
 *
 * `buildAnalyticsEvent` кладёт его в КАЖДЫЙ конверт, стабильным при
 * повторной отправке (генерируется один раз — при постановке в очередь, а
 * не при отправке). `.uuid()`, а не просто непустая строка: колонка в базе
 * — `uuid`, и уникальный индекс на ней это использует; сам генератор
 * (`randomEventId` в schema.ts клиента) всегда отдаёт валидный UUID, включая
 * запасной путь без `crypto.randomUUID`.
 *
 * НЕОБЯЗАТЕЛЕН — и это не небрежность, а совместимость с уже установленными
 * сборками. У ЗАПИСОК четыре оболочки: web, Windows, macOS, Android. Веб
 * обновляется сам, три остальные стоят у людей на устройствах и обновятся
 * когда угодно — или никогда. Та сборка, что установлена сейчас, собрана до
 * появления `event_id`: этого поля в её коде нет вовсе.
 *
 * Сделать поле обязательным значило бы поменять одну причину отказа на
 * другую: до правки приёмник валил 100% событий из-за `schemaVersion`, после
 * валил бы те же 100% из-за отсутствия `eventId`. Для человека с
 * установленным приложением не изменилось бы ничего, а по панели это
 * читалось бы как «починили, но данных всё равно нет».
 *
 * Прислали id (новая сборка) — работает идемпотентность. Не прислали
 * (старая) — сервер выдаёт свой в маршруте приёма: повтор доставки такое
 * событие задвоит, ровно как задваивал до введения ключа. Хуже, чем у новых
 * сборок, но строго лучше отказа. Валидность при этом не ослаблена: если
 * строка пришла — она обязана быть настоящим UUID, колонка в базе `uuid`.
 */
const eventId = z.string().uuid().optional();

const noteSaved = z
  .object({
    event: z.literal('note_saved'),
    ts: z.string().datetime(),
    props: z.object({ length_bucket: lengthBucket, encrypted: z.boolean() }).strict(),
    schemaVersion,
    eventId,
  })
  .strict();

const noteSearched = z
  .object({
    event: z.literal('note_searched'),
    ts: z.string().datetime(),
    props: z.object({ query_length_bucket: lengthBucket, results_count: nonNegativeInt }).strict(),
    schemaVersion,
    eventId,
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
    eventId,
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
    eventId,
  })
  .strict();

export const analyticsEventSchema = z.discriminatedUnion('event', [
  noteSaved,
  noteSearched,
  syncCompleted,
  exportRequested,
]);

export type AnalyticsEvent = z.infer<typeof analyticsEventSchema>;

/**
 * Сколько событий кладёт в ОДИН запрос НАША сборка. Совпадает с
 * `ANALYTICS_MAX_BATCH_SIZE` в `@zapiski/core` (там единственное место, где
 * клиент режет очередь) и с пределом приёмника ПРАКТИКИ, куда мы эти события
 * пересылаем. Менять — только вместе с обоими.
 */
export const MAX_EVENTS_PER_REQUEST = 200;

/**
 * Сколько событий приём СОГЛАСЕН принять. Это НЕ дубль константы выше, у них
 * разный смысл, и в этом вся суть: первая — про то, сколько шлём мы, вторая —
 * про то, сколько мы готовы стерпеть от чужого.
 *
 * Чужой здесь — уже установленная сборка ЗАПИСОК (Windows, macOS, Android),
 * собранная до этой сессии: её очередь режет отправку по 500, а не по 200.
 * Если бы приём отбивал такую пачку, человек с накопленным офлайном не
 * доставил бы НИЧЕГО — батч отвергается целиком, а не частично, и его
 * события не доехали бы никогда, сколько бы он ни выходил в сеть.
 *
 * Предел всё равно есть, просто выше: 501 событие в одном запросе — отказ.
 * Когда установленных старых сборок не останется, это число можно опустить
 * до 200 и слить константы обратно в одну.
 */
export const MAX_EVENTS_ACCEPTED_PER_REQUEST = 500;

export const analyticsBatchBody = z.object({
  events: z.array(analyticsEventSchema).min(1).max(MAX_EVENTS_ACCEPTED_PER_REQUEST),
});
