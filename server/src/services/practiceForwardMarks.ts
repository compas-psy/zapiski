/**
 * Разметка исхода пересылки в ПРАКТИКУ обратно на строки `analytics_events`.
 *
 * Общая точка для ТРЁХ мест, где происходит пересылка (E-Z2/E-Z3):
 * горячий путь после вставки батча (`routes/analytics.ts`), выдача/отзыв
 * согласия (`routes/auth.ts`) и часовой sweep недошедшего
 * (`practiceBridge.retryPracticeForwarding`) — чтобы «что значит accepted/
 * rejected/error для строки в базе» не разъезжалось по трём копиям одной и
 * той же логики.
 */
import type { Db } from '../db/pool.ts';
import type { ForwardResult } from './practiceBridge.ts';

/**
 * `accepted` → `practice_forwarded_at = now()`, `practice_reject_reason` сброшен
 * (могла остаться от более ранней неудачной попытки — 0011).
 * `rejected` → `practice_reject_reason` = дословная причина приёмника (E-Z1:
 * явный след того, что приёмник ОТВЕТИЛ и отказал — не то же самое, что
 * сетевой сбой, и не должно выглядеть так же в базе).
 * `error`    → строка не трогается: следующая попытка (hot path другого
 * события того же аккаунта, либо sweep) попробует снова.
 *
 * `ids` и `results` — параллельные массивы одной длины и порядка (гарантия
 * `PracticeBridge.forward{,Batch}`).
 */
export async function markPracticeForwardResults(
  db: Pick<Db, 'query'>,
  ids: readonly number[],
  results: readonly ForwardResult[],
): Promise<void> {
  const forwardedIds: number[] = [];
  const rejections: { id: number; reason: string }[] = [];

  results.forEach((result, i) => {
    const id = ids[i];
    if (id === undefined) return;
    if (result.outcome === 'accepted') {
      forwardedIds.push(id);
    } else if (result.outcome === 'rejected') {
      rejections.push({ id, reason: result.reason ?? 'rejected' });
    }
  });

  if (forwardedIds.length > 0) {
    await db.query(
      'UPDATE analytics_events SET practice_forwarded_at = now(), practice_reject_reason = NULL WHERE id = ANY($1)',
      [forwardedIds],
    );
  }
  for (const { id, reason } of rejections) {
    await db.query('UPDATE analytics_events SET practice_reject_reason = $2 WHERE id = $1', [id, reason]);
  }
}
