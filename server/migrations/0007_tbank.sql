-- 0007_tbank — приём оплаты через Т-Банк (эквайринг).
--
-- Решение заказчика: «настрой процесс оплаты через ТБанк». ЮKassa и Google
-- Play остаются на месте — провайдер становится третьим, а не заменой: код
-- подписки написан вокруг `activatePaidPeriod`, и ему всё равно, кто принёс
-- деньги.

-- Провайдер в двух местах ограничен списком, и список этот — часть схемы.
-- Расширяем оба, иначе первая же успешная оплата упрётся в CHECK.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_provider_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_provider_check
  CHECK (provider IN ('yookassa', 'google_play', 'tbank'));

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_provider_check;
ALTER TABLE billing_events
  ADD CONSTRAINT billing_events_provider_check
  CHECK (provider IN ('yookassa', 'google_play', 'tbank'));

-- Заказ у Т-Банка — это ТОЛЬКО `OrderId`, и он не длиннее 36 знаков.
-- Ни пользователь, ни тариф в него не помещаются (uuid сам по себе занимает
-- все 36), а уведомление приносит именно его. Поэтому связь «заказ → кто и за
-- что платит» хранится здесь: без неё успешная оплата не знала бы, кому
-- включать подписку.
--
-- Содержимого заметок тут нет и быть не может: только кто, за что и сколько.
CREATE TABLE payment_orders (
  order_id    text        PRIMARY KEY,
  provider    text        NOT NULL CHECK (provider IN ('tbank')),
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan        text        NOT NULL CHECK (plan IN ('monthly', 'yearly')),
  amount_kop  integer     NOT NULL CHECK (amount_kop > 0),
  payment_id  text,
  status      text        NOT NULL DEFAULT 'new',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_orders_user_idx ON payment_orders (user_id, created_at DESC);
