-- 0012_analytics_consent_backfill — контракт контура v2 (E-Z3).
--
-- ПРАКТИКА держит согласие субъекта по событию `consent_updated`: без него
-- на файле все остальные события субъекта отвергаются (контракт §5). Это
-- событие теперь шлёт `POST /api/v1/auth/analytics-consent` (routes/auth.ts)
-- — но только В МОМЕНТ, когда кто-то СЕЙЧАС меняет согласие. Для людей,
-- давших согласие ДО этой правки (`users.analytics_opt_in = true` уже стоит,
-- никакого нового вызова этой ручки не будет, пока они сами не передумают),
-- `consent_updated` никогда не был отправлен — их обычные события так и
-- будут отвергаться ПРАКТИКОЙ бесконечно, sweep не поможет: ему нечего
-- переслать, чтобы снять причину отказа.
--
-- Синтетическая строка здесь — не подмена факта, а его честная фиксация
-- задним числом: согласие РЕАЛЬНО дано (иначе `analytics_opt_in` не было бы
-- `true`), просто до этой миграции некому было сообщить об этом ПРАКТИКЕ.
-- `client_ts = users.updated_at` — ближайшее, что есть к «когда именно» без
-- отдельного журнала согласий (которого у ЗАПИСОК не было до этой задачи).
--
-- `WHERE NOT EXISTS (...)` — защита от повторного накопления дублей, если
-- этот файл когда-нибудь применят повторно (раннер не даёт, см.
-- `schema_migrations`, но защита должна быть в самом SQL, а не только в
-- runtime раннера).
INSERT INTO analytics_events (user_id, event, props, client_ts, event_id, schema_version)
SELECT u.id, 'consent_updated', '{"granted": true}'::jsonb, u.updated_at, gen_random_uuid(), 1
  FROM users u
 WHERE u.analytics_opt_in = true
   AND NOT EXISTS (
     SELECT 1 FROM analytics_events ae WHERE ae.user_id = u.id AND ae.event = 'consent_updated'
   );
