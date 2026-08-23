-- 0010_analytics_practice_bridge — мост в приёмник ПРАКТИКИ (C4,
-- charter/12_ANALYTICS.md §3).
--
-- Событие, принятое `/api/v1/analytics/events`, пересылается в общий контур
-- ПОСЛЕ того, как уже сохранено у ЗАПИСОК — своя копия остаётся всегда,
-- пересылка НИКОГДА не может стать причиной потери принятого. Отсюда два
-- новых поля:
--
-- `schema_version` — версия реестра, в котором событие построено клиентом
-- (`buildAnalyticsEvent`). Маршрут уже проверяет её (analytics-schema.ts,
-- C1), но раньше нигде не сохранял: без колонки повторная попытка переслать
-- событие, отказавшее в первый раз (ПРАКТИКА была недоступна), не смогла бы
-- честно собрать конверт заново — пришлось бы либо гадать версию, либо
-- слать нулевую заглушку.
--
-- `practice_forwarded_at` — когда (если) событие успешно дошло до
-- `/ingest` ПРАКТИКИ. NULL — ещё не пересылалось или все попытки отказали;
-- по нему работает повторная попытка (см. `retryPracticeForwarding`,
-- `server/src/services/practiceBridge.ts`), запускаемая тем же
-- часовым sweep'ом, что и чистка версий/magic-токенов (`index.ts`).
ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS practice_forwarded_at timestamptz;

-- Sweep ищет именно эту выборку — индекс держит её дешёвой независимо от
-- того, сколько строк уже переслано.
CREATE INDEX IF NOT EXISTS analytics_events_unforwarded_idx
  ON analytics_events (id)
  WHERE practice_forwarded_at IS NULL;
