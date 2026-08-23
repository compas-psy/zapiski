/**
 * Уже установленные приложения ЗАПИСОК не должны перестать слать аналитику
 * после выкладки сервера.
 *
 * У ЗАПИСОК четыре оболочки: web, Windows, macOS, Android. Веб обновляется
 * сам, остальные три стоят у людей на устройствах и обновятся когда угодно —
 * или никогда. Сборка, которая сейчас установлена у человека, собрана ДО
 * правок этой сессии: она кладёт в конверт `schemaVersion` (клал всегда), но
 * НЕ кладёт `eventId` — такого поля в её коде не существует, — и режет
 * очередь по 500 событий, а не по 200.
 *
 * Первая редакция правки объявила `eventId` обязательным внутри `.strict()`.
 * Итог был бы издевательский: до правки приёмник отвергал 100% событий из-за
 * `schemaVersion`, после — отвергал бы те же 100%, теперь уже из-за
 * отсутствия `eventId`. Установленные приложения не увидели бы разницы, а по
 * панели это выглядело бы как «починили, но данных всё равно нет».
 *
 * Поэтому: `eventId` — необязателен на приёме. Прислал (новая сборка) —
 * работает идемпотентность. Не прислал (старая) — сервер выдаёт свой id,
 * идемпотентности нет, но событие ПРИНЯТО. Это ровно то поведение, что было
 * до введения ключа, и оно строго лучше отказа.
 */
import { describe, expect, it } from 'vitest';

import { analyticsBatchBody, MAX_EVENTS_PER_REQUEST } from '../src/lib/analytics-schema.ts';

/** Конверт ровно в том виде, в каком его собирает УЖЕ УСТАНОВЛЕННАЯ сборка. */
function legacyEvent() {
  return {
    event: 'note_saved' as const,
    ts: new Date().toISOString(),
    props: { length_bucket: 'm' as const, encrypted: true },
    schemaVersion: 1,
  };
}

describe('совместимость с установленными сборками (Windows, macOS, Android)', () => {
  it('конверт без eventId принимается', () => {
    const parsed = analyticsBatchBody.safeParse({ events: [legacyEvent()] });
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues),
    ).toBe(true);
  });

  it('конверт новой сборки с eventId принимается по-прежнему', () => {
    const withId = { ...legacyEvent(), eventId: '11111111-1111-4111-8111-111111111111' };
    expect(analyticsBatchBody.safeParse({ events: [withId] }).success).toBe(true);
  });

  it('мусор вместо eventId по-прежнему отвергается — необязательный не значит любой', () => {
    const bad = { ...legacyEvent(), eventId: 'не-uuid' };
    expect(analyticsBatchBody.safeParse({ events: [bad] }).success).toBe(false);
  });

  it('пачка в 500 событий от старой очереди принимается целиком', () => {
    // Старая сборка режет очередь по 500 (AnalyticsQueue), а не по 200.
    // Если приём отбивает такую пачку, человек с накопленным офлайном не
    // доставит НИЧЕГО: батч отвергается целиком, а не частично.
    const events = Array.from({ length: 500 }, legacyEvent);
    expect(analyticsBatchBody.safeParse({ events }).success).toBe(true);
  });

  it('501 событие всё-таки отвергается — предел есть, он просто выше', () => {
    const events = Array.from({ length: 501 }, legacyEvent);
    expect(analyticsBatchBody.safeParse({ events }).success).toBe(false);
  });

  it('новые сборки по-прежнему режут по 200 — это отдельная величина', () => {
    expect(MAX_EVENTS_PER_REQUEST).toBe(200);
  });
});
