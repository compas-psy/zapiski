-- Единственный эквайринг портфеля — Т-Касса (решение учредителя 18.08.2026).
-- ЮKassa и Google Play Billing удалены из кода: у Google с декабря 2024 нет
-- выплат российским разработчикам, а два провайдера на два продукта — это две
-- сверки и два места, где ломается.
--
-- Миграция только расширяющая: старые значения остаются разрешёнными, чтобы
-- уже записанная история платежей не перестала проходить проверку. Ничего не
-- удаляется и не переписывается.

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_provider_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_provider_check
  CHECK (provider IN ('tbank', 'yookassa', 'google_play'));

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_provider_check;
ALTER TABLE billing_events
  ADD CONSTRAINT billing_events_provider_check
  CHECK (provider IN ('tbank', 'yookassa', 'google_play'));
