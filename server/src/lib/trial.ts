/**
 * Длительность пробного периода — правило заказчика для MVP.
 *
 * «Триал 30 дней без оплаты для подключивших облако до 01.09.2026; далее триал
 * сокращается до 14 дней».
 *
 * ── Почему правило продублировано, и как это не разъедется ──────────────────
 *
 * Источник правды — `packages/core/src/trial.ts`: по нему интерфейс обещает
 * срок при подключении облака. Сервер живёт отдельным рантаймом и на `@zapiski
 * /core` не зависит, тянуть весь пакет ради двух чисел неправильно. Поэтому
 * здесь копия — а от расхождения защищает тест `server/test/trial.test.ts`,
 * который сверяет числа и границу с теми же значениями. Разъедутся — покраснеет.
 */

/** Ранние 30 дней — подключившим СТРОГО до этого момента. */
export const TRIAL_EARLY_UNTIL = Date.UTC(2026, 8, 1);
export const TRIAL_DAYS_EARLY = 30;
export const TRIAL_DAYS_REGULAR = 14;

export function trialDaysFor(connectedAt: number): number {
  return connectedAt < TRIAL_EARLY_UNTIL ? TRIAL_DAYS_EARLY : TRIAL_DAYS_REGULAR;
}
