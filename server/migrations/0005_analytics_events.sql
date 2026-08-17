-- 0005_analytics_events — продуктовая аналитика (ТЗ §6, O-260817-05).
--
-- Только расширяющая миграция: новая таблица, ничего существующего не
-- трогает. `POST /api/v1/analytics/events` пишет сюда за флагом
-- ANALYTICS_ENABLED (по умолчанию выключен) и только для пользователей с
-- users.analytics_opt_in = true — обе проверки в коде маршрута, здесь только
-- хранение.
--
-- charter/12_ANALYTICS.md §1, правило 2: содержание не измеряется никогда.
-- `props` — не свободная колонка: маршрут кладёт туда только то, что прошло
-- через реестр `analytics/schema/events.yaml` (whitelist по имени события и
-- по названию/типу поля). Схема БД это не может проверить — проверяет код,
-- test/analytics.events.test.ts держит оба места в согласии.

CREATE TABLE analytics_events (
  id          bigserial   PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event       text        NOT NULL,
  props       jsonb       NOT NULL,
  -- Момент на устройстве в момент события — не момент получения сервером:
  -- офлайн-очередь может доставить событие часы спустя.
  client_ts   timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analytics_events_event_received_idx ON analytics_events (event, received_at);
CREATE INDEX analytics_events_user_idx ON analytics_events (user_id, received_at);
