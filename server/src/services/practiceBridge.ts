/**
 * Мост в приёмник ПРАКТИКИ (`POST /ingest`, `charter/12_ANALYTICS.md §3`, C4).
 *
 * События, принятые `/api/v1/analytics/events`, дублируются в общий контур —
 * туда, откуда читает управленческая панель. У ЗАПИСОК своя копия остаётся
 * ВСЕГДА: пересылка — это ДОПОЛНЕНИЕ к приёму, а не замена, и её отказ не
 * должен ронять и не должен терять принятое.
 *
 * ── Честность про то, что на другой стороне ─────────────────────────────────
 *
 * Конверт здесь собран по `charter/12_ANALYTICS.md §3` — так, как его
 * описывает документ. Но прочитанный код самого `/ingest` ПРАКТИКИ
 * (`/tmp/work/cmpas.ru/src/app/api/ingest/route.ts` и
 * `src/lib/analytics/{ingest,schema}.ts`, читано 23.08.2026) на сегодня:
 *  - принимает ОДНО событие за запрос, не батч — `forward()` поэтому шлёт
 *    по одному, а не оборачивает в `{events:[...]}`;
 *  - НЕ проверяет вообще никакой заголовок аутентификации — секрет здесь
 *    форвард-совместим на будущее (Д-10 в `06_ANALYTICS.md`), а не защита
 *    сегодня;
 *  - ищет `account_id` как `User.id` В СВОЕЙ БД и отвергает
 *    `unknown account_id`, если такого там нет. У ЗАПИСОК свой, отдельный
 *    аккаунт (`B-260813-14`) — общего `sub` ещё нет, поэтому `account_id`,
 *    который шлёт этот мост, ПРАКТИКА сегодня не узнает почти никогда.
 *
 * Это не повод не строить мост: он готов к моменту, когда общая
 * идентичность появится, и работает уже сейчас как факт пересылки (тест
 * проверяет именно это — что уходит правильный конверт, а не что ПРАКТИКА
 * его обязательно проглотит). Подробности — в отчёте задачи C4, не здесь.
 */

import type { Db } from '../db/pool.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Единый конверт контура (`12_ANALYTICS.md §3`). */
export interface PracticeEnvelope {
  event: string;
  ts: string;
  product: 'zapiski';
  account_id: string | null;
  /**
   * Всегда `null`: `analytics_events` ЗАПИСОК не хранит `device_id` события
   * (только `user_id`) — персистентность его добавила бы отдельную колонку
   * и решение, из чьего именно устройства слать при ретрае с sweep'а, а не
   * из запроса. У ПРАКТИКИ это поле опционально и на решение «принять/
   * отвергнуть» не влияет, пока `account_id` присутствует (см. шапку файла,
   * `writeAccountEvent`), так что упрощение не меняет исход сегодня.
   */
  device_id: string | null;
  props: Record<string, unknown>;
  schema_version: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Один POST на одно событие. Никогда не бросает: сетевой отказ, таймаут,
 * не-2xx — всё превращается в `false`, а не в исключение, потому что вызывающая
 * сторона (маршрут приёма) обязана в любом случае продолжить отвечать
 * своему клиенту, а не заваливать приём ЗАПИСОК из-за недоступности ПРАКТИКИ.
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

  async forward(envelope: PracticeEnvelope): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Форвард-совместимо: сегодня /ingest ПРАКТИКИ этот заголовок не
          // читает (см. шапку файла) — заведён здесь, чтобы включение
          // проверки на той стороне не потребовало правки этого репозитория.
          'x-simpas-ingest-secret': this.#secret,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
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
  };
}

const RETRY_BATCH_LIMIT = 200;

/**
 * Sweep для того, что не переслалось с первой попытки (ПРАКТИКА была
 * недоступна, ответила не-2xx, поймала таймаут). Запускается тем же часовым
 * циклом, что чистка версий и magic-токенов (`index.ts`) — раз в час
 * достаточно: пересылка — это дополнение к приёму, а не путь, от которого
 * зависит сам приём (тот отвечает клиенту сразу, независимо от исхода
 * немедленной попытки пересылки в маршруте).
 *
 * Отсутствие моста (`practiceBridge === null`) — не ошибка sweep'а: значит,
 * пересылка выключена настройкой, а не то, что она сейчас недоступна.
 */
export async function retryPracticeForwarding(
  ctx: { db: Pick<Db, 'query'>; practiceBridge: PracticeBridge | null },
  limit: number = RETRY_BATCH_LIMIT,
): Promise<{ attempted: number; forwarded: number }> {
  if (ctx.practiceBridge === null) return { attempted: 0, forwarded: 0 };

  const { rows } = await ctx.db.query<ForwardableRow>(
    `SELECT id, user_id, event, props, client_ts, schema_version
       FROM analytics_events
      WHERE practice_forwarded_at IS NULL
      ORDER BY id
      LIMIT $1`,
    [limit],
  );

  // По одному, последовательно: /ingest ПРАКТИКИ сегодня не батч (см. шапку
  // файла), и посылать сотни параллельных запросов на недоступный сервис —
  // не ускорение, а лишняя нагрузка на обе стороны.
  let forwarded = 0;
  for (const row of rows) {
    const ok = await ctx.practiceBridge.forward(envelopeFor(row));
    if (ok) {
      await ctx.db.query('UPDATE analytics_events SET practice_forwarded_at = now() WHERE id = $1', [row.id]);
      forwarded += 1;
    }
  }
  return { attempted: rows.length, forwarded };
}
