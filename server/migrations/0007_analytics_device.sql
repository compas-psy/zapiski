-- Устройство без аккаунта тоже может присылать метаданные (O-260817-15,
-- по модели O-260817-13 для cmpas.ru: «устройство как носитель личности»).
-- Вход в проде не доведён, а ЗАПИСКИ — локальное приложение: аккаунт для
-- метаданных не нужен по существу продукта.
--
-- Только расширяющая миграция: user_id становится nullable, добавляется
-- device_id и отдельная таблица согласия по устройству — ничего
-- существующего не трогает, старые строки с user_id читаются как прежде.

ALTER TABLE analytics_events
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN device_id text,
  ADD CONSTRAINT analytics_events_owner_chk CHECK (user_id IS NOT NULL OR device_id IS NOT NULL);

CREATE INDEX analytics_events_device_idx
  ON analytics_events (device_id, received_at)
  WHERE device_id IS NOT NULL;

-- Согласие устройства без аккаунта — тот же смысл, что у users.analytics_opt_in
-- (0001_accounts.sql), но по deviceId вместо user_id: у анонимного устройства
-- нет строки в users, класть согласие больше некуда. Тот же deviceId, что уже
-- несёт клиент для входа (SessionStore.deviceId(), формат isValidDeviceKey) —
-- не второй, отдельно выдуманный идентификатор.
CREATE TABLE analytics_device_consent (
  device_id   text        PRIMARY KEY,
  opt_in      boolean     NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN analytics_events.device_id IS
  'Идентификатор устройства без аккаунта (O-260817-15). NULL — событие пришло с account_id, как раньше.';
COMMENT ON TABLE analytics_device_consent IS
  'Согласие на продуктовую аналитику для устройства без аккаунта. Отозвано — opt_in = false, строка остаётся (момент решения важен так же, как у users.marketing_at).';
