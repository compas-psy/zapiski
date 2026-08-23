/**
 * Уборка обязана пройти хотя бы раз ПОСЛЕ старта, а не только через час.
 *
 * ── Что нашлось ──────────────────────────────────────────────────────────────
 *
 * `server/src/index.ts` заводил уборку одним `setInterval(..., 60*60*1000)` —
 * без единого прогона на старте. Первая уборка, а вместе с ней и повтор
 * пересылки в ПРАКТИКУ (`retryPracticeForwarding`, C4), случалась не раньше
 * чем через час ПОСЛЕ подъёма контейнера.
 *
 * Само по себе это ещё не поломка. Поломкой это делает выкладка: каждый
 * деплой пересоздаёт контейнер и обнуляет отсчёт. В день, когда выкладок
 * больше одной в час — а сегодня их было четыре, — таймер не доживает до
 * срабатывания НИ РАЗУ, и события с `practice_forwarded_at IS NULL` не
 * пересылаются никогда. Ничего при этом не падает и не пишется в лог: отказ
 * выглядит как «мост включён, но переслано 0».
 *
 * Прямой факт из прогона 164 (лог шага «Проверить аналитику и мост»):
 * «всего 1, за сутки 1, переслано 0, отвергнуто 0, ждёт 1» при
 * `PRACTICE_INGEST_SECRET: задан (64 символов)`.
 *
 * Событие туда попало не из маршрута, а из миграции `0012_analytics_consent_
 * backfill.sql` — то есть по строчному пути пересылки (inline в
 * `routes/analytics.ts`) оно не проходило и ЗАВИСИТ от sweep целиком.
 *
 * ── Что проверяется ──────────────────────────────────────────────────────────
 *
 * Настоящий `startSweeper` на поддельных таймерах: прогон вскоре после старта
 * и продолжение по расписанию. Никакой сети и базы — уборка передаётся
 * колбэком.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SWEEP_FIRST_RUN_MS, SWEEP_INTERVAL_MS, startSweeper } from '../src/services/sweep.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('уборка после старта', () => {
  it('первый прогон — вскоре после старта, а не через час', async () => {
    const runs: number[] = [];
    const stop = startSweeper(async () => {
      runs.push(1);
    });

    expect(runs).toHaveLength(0); // не на нулевой миллисекунде: старт не тормозим
    await vi.advanceTimersByTimeAsync(SWEEP_FIRST_RUN_MS);
    expect(runs).toHaveLength(1);

    stop();
  });

  it('первый прогон заметно раньше часа — иначе перезапуск съедает его целиком', () => {
    expect(SWEEP_FIRST_RUN_MS).toBeLessThan(SWEEP_INTERVAL_MS / 10);
  });

  it('дальше — по расписанию, и стартовый прогон расписание не задваивает', async () => {
    const runs: number[] = [];
    const stop = startSweeper(async () => {
      runs.push(1);
    });

    await vi.advanceTimersByTimeAsync(SWEEP_FIRST_RUN_MS);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(runs).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(runs).toHaveLength(3);

    stop();
  });

  it('stop() останавливает и стартовый прогон, и расписание', async () => {
    const runs: number[] = [];
    const stop = startSweeper(async () => {
      runs.push(1);
    });

    stop();
    await vi.advanceTimersByTimeAsync(SWEEP_FIRST_RUN_MS + SWEEP_INTERVAL_MS * 2);
    expect(runs).toHaveLength(0);
  });

  it('отказ уборки не роняет расписание — следующий прогон всё равно будет', async () => {
    let calls = 0;
    const stop = startSweeper(async () => {
      calls += 1;
      throw new Error('база не ответила');
    });

    await vi.advanceTimersByTimeAsync(SWEEP_FIRST_RUN_MS);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(calls).toBe(2);

    stop();
  });
});
