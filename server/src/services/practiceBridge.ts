/**
 * Мост в приёмник ПРАКТИКИ (`POST /ingest`, `charter/12_ANALYTICS.md §3`, C4).
 *
 * События, принятые `/api/v1/analytics/events`, дублируются в общий контур —
 * туда, откуда читает управленческая панель. У ЗАПИСОК своя копия остаётся
 * ВСЕГДА: пересылка — это ДОПОЛНЕНИЕ к приёму, а не замена, и её отказ не
 * должен ронять и не должен терять принятое.
 *
 * ── Контракт контура v2 (решение оркестратора, O-260823-E) ──────────────────
 *
 * Поток C построил этот мост, читая старую копию репозитория ПРАКТИКИ — до
 * того, как приёмник переписали. Три утверждения о другой стороне, зафикси-
 * рованные тогда в этом файле, были на день его написания правдой и
 * перестали быть правдой к сегодняшнему прочтению актуального кода приёмника
 * (`src/app/api/ingest/route.ts`, `src/lib/analytics/{ingest,schema,rate-
 * limit}.ts`, `analytics/schema/events.yaml` — читано 23.08.2026, в отдельном
 * дереве, не тронуто):
 *
 *  - приёмник фактически требует `Authorization: Bearer <секрет>` и
 *    fail-closed отдаёт 401 на всё остальное (raw заголовок `authorization`,
 *    ожидается `Bearer <ANALYTICS_INGEST_SECRET>`, `timingSafeEqual`).
 *    Заголовка `x-simpas-ingest-secret`, который слал этот мост, приёмник не
 *    знает вовсе — каждый форвард получал бы 401, то есть отдавался бы этим
 *    же кодом как неудача, но по ошибочной причине (не "мост не нужен",
 *    а "мост стучится не туда, куда слушают");
 *  - приёмник принимает не только одно событие, но и МАССИВ до 200 штук за
 *    запрос, отвечая `{results:[...]}` в том же порядке, поэлементно;
 *  - `account_id`, который шлёт ЗАПИСКИ, ПРАКТИКА для `product: 'zapiski'`
 *    больше не ищет в своей таблице `User` — это исправлено на её стороне
 *    ПРИ УСЛОВИИ, что согласие субъекта `zapiski:<account_id>` у неё на файле
 *    (ставится событием `consent_updated`, см. ниже).
 *
 * Этот файл доведён до контракта контура v2, а не до прочитанного 23.08.2026
 * кода приёмника напрямую — контракт оркестратора старше кода и обязателен
 * для всех трёх репозиториев контура; расхождения между ним и тем, что
 * фактически лежит в дереве приёмника на день чтения (в частности: реестр
 * `events.yaml` там ещё не разрешает `consent_updated`/`identity_linked`
 * продукту `zapiski` — это правится параллельно другим потоком; а обработчик
 * `account_id` там пока СОВПАДАЕТ со старым поведением — ищет `User.id`
 * буквально, независимо от продукта, без схемы `product:account_id` из
 * контракта) — не повод не строить мост по контракту: контракт описывает,
 * куда приёмник придёт, а не только то, где он есть сегодня. Подробности —
 * в отчёте задачи E (поток «контракт-E»), не здесь.
 */

import type { Db } from '../db/pool.ts';
import { markPracticeForwardResults } from './practiceForwardMarks.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Единый конверт контура (`12_ANALYTICS.md §3`, контракт контура v2 §4). */
export interface PracticeEnvelope {
  event: string;
  ts: string;
  product: 'zapiski';
  account_id: string | null;
  /**
   * Всегда `null`: `analytics_events` ЗАПИСОК не хранит `device_id` события
   * (только `user_id`) — персистентность его добавила бы отдельную колонку
   * и решение, из чьего именно устройства слать при ретрае с sweep'а, а не
   * из запроса. У ПРАКТИКИ это поле опционально и не мешает решению
   * «принять/отвергнуть», пока `account_id` присутствует, так что упрощение
   * не меняет исход.
   */
  device_id: string | null;
  props: Record<string, unknown>;
  schema_version: number;
  /**
   * Ключ идемпотентности НА СТОРОНЕ ПРАКТИКИ (контракт контура v2 §4).
   * Всегда тот же `event_id`, что уже применяется для собственной
   * идемпотентности ЗАПИСОК (Д-6, C3, уникальный индекс на
   * `analytics_events.event_id`) — эта колонка стабильна с момента
   * постановки в очередь, а не пересобирается при отправке, и годится для
   * ОБЕИХ систем сразу без второго генератора.
   *
   * До этой правки конверт его не нёс вовсе: таймаут ответа (мост трактует
   * его как неудачу, `PracticeBridge.forward` — см. ниже) при фактически
   * доставленном на приёме запросе привёл бы sweep к повторной отправке БЕЗ
   * ключа, на который приёмник мог бы опереться, — задвоенная строка в
   * `events` ПРАКТИКИ на каждый такой пограничный случай.
   */
  event_id: string;
}

/**
 * Итог одной строки после попытки пересылки (E-Z1: `response.ok` — не
 * критерий успеха, критерий — явное `{accepted:true}` в разобранном теле).
 *
 *  - `accepted`   — приёмник подтвердил приём этой строки;
 *  - `rejected`   — приёмник ОТВЕТИЛ (обычно 200) и явно отказал
 *    (`{accepted:false, reason}`). Это НЕ потеря и НЕ ошибка транспорта: у
 *    приёмника есть мнение о конверте, и чаще всего это мнение — «согласия
 *    субъекта нет на файле» (контракт контура v2 §5). Повторять ровно тот же
 *    конверт бессмысленно, пока причина не снята (согласие получено), но мы
 *    и не удаляем его из очереди непереслaнных — `consent_updated`,
 *    отправленный позже, сам расчистит путь для честного повтора sweep'ом.
 *    `reason` — сырая строка приёмника, для лога и `practice_reject_reason`
 *    (см. `retryPracticeForwarding`), не для программного ветвления по
 *    конкретным словам: формулировки — контроль другой команды.
 *  - `error`      — транспортный сбой (сеть, таймаут, не-2xx) ИЛИ ответ,
 *    который не удалось разобрать по контракту (не то тело, не тот размер
 *    `results`). Здесь мы буквально не знаем, что случилось на той стороне —
 *    в отличие от `rejected`, где приёмник произнёс мнение вслух.
 */
export type ForwardOutcome = 'accepted' | 'rejected' | 'error';

export interface ForwardResult {
  outcome: ForwardOutcome;
  /** Только при `outcome === 'rejected'` — причина отказа из тела ответа приёмника. */
  reason?: string;
}

const ACCEPTED: ForwardResult = { outcome: 'accepted' };
const ERROR: ForwardResult = { outcome: 'error' };

function rejectedResult(reason: unknown): ForwardResult {
  return { outcome: 'rejected', reason: typeof reason === 'string' && reason.length > 0 ? reason : 'rejected (no reason given)' };
}

/** Один элемент разобранного `results` → `ForwardResult`. Не доверяем форме, которой не просили. */
function classify(item: unknown): ForwardResult {
  if (item !== null && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    if (record['accepted'] === true) return ACCEPTED;
    if (record['accepted'] === false) return rejectedResult(record['reason']);
  }
  return ERROR;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Наибольшая пачка, которую примет `POST /ingest` ПРАКТИКИ за один запрос
 * (контракт контура v2 §2). Единственное место, где это число живёт на
 * стороне ЗАПИСОК: и горячая пересылка (`routes/analytics.ts`), и sweep
 * (`retryPracticeForwarding`) режут на HTTP-запросы через
 * `PracticeBridge.forwardBatch`, а не переопределяют константу заново.
 */
export const MAX_INGEST_BATCH_SIZE = 200;

/**
 * Мост в `POST /ingest` ПРАКТИКИ. Никогда не бросает: сетевой отказ, таймаут,
 * не-2xx, неожиданная форма ответа — всё превращается в `ForwardResult`
 * (`outcome: 'error'`), а не в исключение, потому что вызывающая сторона
 * (маршрут приёма, sweep) обязана в любом случае продолжить свою работу, а
 * не заваливаться из-за недоступности или недопонятности ПРАКТИКИ.
 */
export class PracticeBridge {
  readonly #url: string;
  readonly #secret: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(url: string, secret: string, fetchImpl: FetchLike = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.#url = url;
    this.#secret = secret;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Один HTTP-запрос на массив ≤ `MAX_INGEST_BATCH_SIZE` конвертов. Тело
   * ВСЕГДА массив — даже из одного элемента: единая точка разбора `results`,
   * без двух разных форм ответа на разные формы запроса. `forward()` и
   * `forwardBatch()` — оба тонкие обёртки вокруг этого метода.
   */
  async #postChunk(envelopes: readonly PracticeEnvelope[]): Promise<ForwardResult[]> {
    if (envelopes.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Контракт контура v2 §1: единственный формат — Bearer. Заголовок
          // `x-simpas-ingest-secret`, который был здесь раньше, приёмник не
          // читает вовсе (см. шапку файла) — 401 на каждый форвард.
          authorization: `Bearer ${this.#secret}`,
        },
        body: JSON.stringify(envelopes),
        signal: controller.signal,
      });

      const body: unknown = await response.json().catch(() => null);

      // Не-2xx — транспортная неудача целиком, вне зависимости от тела
      // (контракт контура v2 §3: отказ по существу приходит НА 200, а не на
      // 401/500 — те не несут содержательного results).
      if (!response.ok || body === null || typeof body !== 'object') {
        return envelopes.map(() => ERROR);
      }

      const results = (body as Record<string, unknown>)['results'];
      if (!Array.isArray(results) || results.length !== envelopes.length) {
        // 2xx, но не тем контрактом (нет `results` нужной длины). Считать
        // это успехом значило бы поверить голому `response.ok`, а не явному
        // `{accepted:true}` — ровно то, от чего предостерегает контракт §1.
        return envelopes.map(() => ERROR);
      }

      return results.map(classify);
    } catch {
      return envelopes.map(() => ERROR);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Пересылка МАССИВОМ (контракт контура v2 §2), с чанкованием по
   * `MAX_INGEST_BATCH_SIZE` внутри — вызывающая сторона может передать
   * сколько угодно конвертов, мост сам режет на допустимые HTTP-запросы и
   * склеивает результаты в исходном порядке. Один неудачный чанк не топит
   * остальные — каждый чанк независим.
   */
  async forwardBatch(envelopes: readonly PracticeEnvelope[]): Promise<ForwardResult[]> {
    const results: ForwardResult[] = [];
    for (let i = 0; i < envelopes.length; i += MAX_INGEST_BATCH_SIZE) {
      const chunk = envelopes.slice(i, i + MAX_INGEST_BATCH_SIZE);
      results.push(...(await this.#postChunk(chunk)));
    }
    return results;
  }

  /**
   * Один конверт. «Горячий путь» одного события — по-прежнему по одному
   * HTTP-запросу на вызов (не накапливается с другими вызовами в этом же
   * процессе), но тело этого запроса — массив из одного элемента, тем же
   * кодом, что и `forwardBatch`: не два разных парсера ответа на два разных
   * формата тела, один.
   */
  async forward(envelope: PracticeEnvelope): Promise<ForwardResult> {
    const [result] = await this.#postChunk([envelope]);
    return result ?? ERROR;
  }
}

/**
 * `null`, если адрес или секрет не заданы — мост ВЫКЛЮЧЕН, а не отправляет
 * без аутентификации. Оба должны быть заданы вместе (см. env.ts): один без
 * другого — та же самая небезопасная ситуация, только зеркальная.
 */
export function createPracticeBridge(
  env: { PRACTICE_INGEST_URL?: string; PRACTICE_INGEST_SECRET?: string },
  fetchImpl?: FetchLike,
  timeoutMs?: number,
): PracticeBridge | null {
  const { PRACTICE_INGEST_URL: url, PRACTICE_INGEST_SECRET: secret } = env;
  if (url === undefined || url.length === 0 || secret === undefined || secret.length === 0) return null;
  return new PracticeBridge(url, secret, fetchImpl, timeoutMs);
}

/** Строка `analytics_events`, которой хватает, чтобы честно собрать конверт заново. */
export interface ForwardableRow {
  id: number;
  user_id: string;
  event: string;
  props: Record<string, unknown>;
  client_ts: Date;
  schema_version: number;
  event_id: string;
}

export function envelopeFor(row: ForwardableRow): PracticeEnvelope {
  return {
    event: row.event,
    ts: row.client_ts.toISOString(),
    product: 'zapiski',
    account_id: row.user_id,
    device_id: null,
    props: row.props,
    schema_version: row.schema_version,
    event_id: row.event_id,
  };
}

/**
 * Сколько непереслaнных строк рассматривать за ОДИН вызов sweep'а (SQL
 * `LIMIT`) — не путать с `MAX_INGEST_BATCH_SIZE` (сколько уместится в ОДИН
 * HTTP-запрос): это разные пределы разных ресурсов. Задан заметно больше
 * сетевого предела, чтобы один часовой тик мог вычерпать здоровый бэклог
 * (например, после временной недоступности ПРАКТИКИ) за несколько
 * HTTP-запросов внутри одного вызова, а не по 200 строк в час до
 * бесконечности — `forwardBatch` сам порежет эту выборку по 200 на запрос.
 */
const SWEEP_ROW_LIMIT = 1_000;

/**
 * Sweep для того, что не переслалось с первой попытки (ПРАКТИКА была
 * недоступна, ответила не-2xx, отвергла, поймала таймаут). Запускается тем
 * же часовым циклом, что чистка версий и magic-токенов (`index.ts`) — раз в
 * час достаточно: пересылка — это дополнение к приёму, а не путь, от
 * которого зависит сам приём.
 *
 * Отсутствие моста (`practiceBridge === null`) — не ошибка sweep'а: значит,
 * пересылка выключена настройкой, а не то, что она сейчас недоступна.
 *
 * Порядок выборки — `ORDER BY id` (глобальный, по возрастанию) — важен не
 * только для повторяемости: `id` монотонно растёт со временем вставки, а
 * `consent_updated` для аккаунта всегда вставляется РАНЬШЕ последующих
 * событий этого же аккаунта (это отдельная строка, вставленная в момент
 * согласия — см. `routes/auth.ts`). Раз `forwardBatch` шлёт срез в том же
 * порядке, в каком получил, а приёмник обрабатывает массив по порядку
 * (контракт контура v2 §5), это единственное, что нужно для правила «согласие
 * — до или вместе с первым содержательным событием»: ничего специально
 * группировать по аккаунту не требуется.
 */
export async function retryPracticeForwarding(
  ctx: { db: Pick<Db, 'query'>; practiceBridge: PracticeBridge | null },
  limit: number = SWEEP_ROW_LIMIT,
): Promise<{ attempted: number; forwarded: number }> {
  if (ctx.practiceBridge === null) return { attempted: 0, forwarded: 0 };

  const { rows } = await ctx.db.query<ForwardableRow>(
    `SELECT id, user_id, event, props, client_ts, schema_version, event_id
       FROM analytics_events
      WHERE practice_forwarded_at IS NULL
      ORDER BY id
      LIMIT $1`,
    [limit],
  );

  if (rows.length === 0) return { attempted: 0, forwarded: 0 };

  const results = await ctx.practiceBridge.forwardBatch(rows.map(envelopeFor));
  await markPracticeForwardResults(ctx.db, rows.map((row) => row.id), results);
  const forwarded = results.filter((r) => r.outcome === 'accepted').length;

  return { attempted: rows.length, forwarded };
}
