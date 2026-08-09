-- 0003_billing_publish — подписка, идемпотентность вебхуков, публичные страницы.

-- ТЗ §5.5: 199 ₽/мес, 149 ₽/мес при годовой; пробный период 14 дней;
-- при истечении данные НЕ блокируются — запрещается только запись.
CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid        NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  plan                     text        NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'trial', 'monthly', 'yearly')),
  status                   text        NOT NULL DEFAULT 'none'
    CHECK (status IN ('none', 'trial', 'active', 'grace', 'expired')),
  trial_started_at         timestamptz,
  trial_ends_at            timestamptz,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  grace_ends_at            timestamptz,
  provider                 text CHECK (provider IN ('yookassa', 'google_play')),
  provider_customer_id     text,
  provider_subscription_id text,
  auto_renew               boolean     NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_period_idx ON subscriptions (current_period_end);
CREATE INDEX subscriptions_provider_sub_idx ON subscriptions (provider, provider_subscription_id);

-- Уведомления платёжных провайдеров. Нужны для идемпотентности: одно и то же
-- событие может прийти несколько раз. Полезной нагрузки заметок здесь нет.
CREATE TABLE billing_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text        NOT NULL CHECK (provider IN ('yookassa', 'google_play')),
  event_id    text        NOT NULL,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  event_type  text        NOT NULL,
  payload     jsonb       NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- Публикация по ссылке (ТЗ §5.3, P1). HTML присылает клиент — сервер ключей
-- не имеет и markdown из шифротекста отрендерить не может.
--
-- Сам HTML лежит в томе, а не в колонке: единственный способ у сервера
-- «увидеть» открытый текст — это то, что пользователь опубликовал сам, и
-- держать его в БД рядом с зашифрованными данными не нужно.
CREATE TABLE published_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slug         text        NOT NULL UNIQUE,
  storage_key  text        NOT NULL,
  content_hash text        NOT NULL,
  size         bigint      NOT NULL CHECK (size >= 0),
  note_id      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE INDEX published_pages_user_idx ON published_pages (user_id) WHERE revoked_at IS NULL;
