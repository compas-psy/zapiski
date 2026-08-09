-- 0001_accounts — аккаунты, устройства, magic-токены, сессии.
--
-- ТЗ §5.5: паролей нет вообще; SMS не используется нигде (прямой запрет).
-- Поэтому в схеме нет ни password_hash, ни phone, ни otp — и не появится.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Почта — единственный идентификатор пользователя. Телефона нет намеренно.
  email             text        NOT NULL,
  email_verified_at timestamptz,
  -- Яндекс ID — основной путь входа (ТЗ §5.5).
  yandex_id         text UNIQUE,
  -- ТЗ §6: аналитика opt-in. По умолчанию выключена.
  analytics_opt_in  boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Устройство пользователя. Человекочитаемое имя устройства НЕ хранится:
-- это пользовательские данные, а серверу для протокола хватает ключа.
CREATE TABLE devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- device_id, который генерирует клиент.
  device_key   text        NOT NULL,
  -- 'web' | 'windows' | 'android' — только для фида обновлений и метрик.
  platform     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_key)
);

-- Magic-link: одноразовый токен, TTL 15 мин, привязан к устройству инициации.
-- Сам токен не хранится — только SHA-256 от него.
CREATE TABLE magic_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text        NOT NULL,
  token_hash text        NOT NULL UNIQUE,
  -- Привязка к устройству инициации (ТЗ §5.5).
  device_key text        NOT NULL,
  platform   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Одноразовость: непустое значение означает, что токен уже обменян.
  used_at    timestamptz
);

-- Для проверки «не чаще письма в 60 секунд на адрес» (SCREENS §2).
CREATE INDEX magic_tokens_email_created_idx ON magic_tokens (lower(email), created_at DESC);
CREATE INDEX magic_tokens_expires_idx ON magic_tokens (expires_at);

-- Сессия = пара access-JWT + refresh-токен с возможностью отзыва.
CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id          uuid        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  -- Refresh-токен хранится только хешем.
  refresh_token_hash text        NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoked_reason     text
);

CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
