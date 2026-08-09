# `server` — KompasCloud API

Облачный бэкенд: Node 22 + Fastify 5 + PostgreSQL 16
([ADR-0003](../../adr/0003-backend-na-node-i-izolyaciya-na-cmpas-ru.md)).

Сервер — **тупая труба для зашифрованных чанков**. Он хранит блобы, версии и
CRDT-апдейты, не понимая их содержимого, и никакой логики над текстом не
выполняет. Это не позиция, а конструкция: ключей у него нет.

Базовый адрес продакшена — `https://zapiski.cmpas.ru`, порт внутри — **3100,
только на loopback** (порт 3000 занят КОМПАС.Дневником, 25 — почтой; ADR-0003
§2). Префикс API — `/api/v1`.

---

## Модель zero-knowledge

**Что сервер знает:**

* путь файла внутри vault'а (`Проекты/Идея.md.enc`) — он нужен для синка;
* размер, `mtime`, ETag (SHA-256 шифротекста), ключ хранения;
* идентификатор заметки (непрозрачная строка от клиента);
* email аккаунта, идентификатор устройства, состояние подписки;
* HTML тех страниц, которые пользователь **сам** решил опубликовать.

**Чего сервер не знает и знать не может:**

* содержимого заметок — приходят только зашифрованные байты;
* пароля шифрования и производных от него ключей;
* смысла CRDT-апдейтов: это `bytea`, который он складывает и отдаёт обратно.

**Чего сервер принципиально не может сделать:**

| Не может | Почему |
| --- | --- |
| Прочитать заметку | Ключ выводится из пароля на устройстве (Argon2id), на сервер не отправляется никогда |
| Восстановить забытый пароль | Его нет ни в каком виде — ни хеша, ни подсказки на сервере |
| Выполнить поиск по содержимому | Индекс живёт на устройстве; сервер видит шифротекст |
| Слить конфликт | Слияние — CRDT/diff3 на клиенте; сервер только хранит версии |
| Отрендерить публикацию из заметки | HTML присылает клиент — сам сервер markdown из шифротекста не получит |
| Заблокировать данные при истечении подписки | Запрещается только запись; все GET работают всегда |

Схема БД проверяется тестом `test/schema.zero-knowledge.test.ts`: в ней нет и
не может появиться колонки с открытым текстом заметки.

Приватность логов (ТЗ §6, `lib/logging.ts`): пути внутри vault'а в журнал не
попадают — вместо них `path#<короткий хеш>`; из query вычищаются `token`,
`code`, `access_token`, `refresh_token`, `email`, `state`; слаг публичной
страницы тоже хешируется. Проверяется `test/privacy.logging.test.ts`.

---

## Справочник API

Общее для всех защищённых маршрутов:

* заголовок `Authorization: Bearer <accessToken>`;
* `X-Device-Id: <deviceKey>` — идентификатор устройства;
* ошибка приходит единым конвертом
  `{"error":{"code":"...","message":"..."}}`, где `message` — текст **дословно
  из реестра `BEHAVIOR.md` §11**, если ситуация в нём есть;
* лимит запросов: 600/мин глобально, **20 за 5 минут** на маршрутах входа;
  превышение → `429` + `Retry-After`.

### Общие коды ошибок

| Код | HTTP | `code` | Текст |
| --- | --- | --- | --- |
| Некорректный запрос | 400 | `bad_request` и уточнения (`bad_path_*`, `bad_note_id`, …) | «Не удалось разобрать запрос» |
| Нужен вход | 401 | `auth_required` | «Нужно войти в аккаунт КОМПАС» |
| Сессия истекла/отозвана | 401 | `session_expired` | «Сессия закончилась. Войдите снова» |
| Подписка истекла (только запись) | 402 | `subscription_expired` | «Подписка закончилась. Заметки на месте, синхронизация через облако КОМПАС приостановлена» |
| Не найдено | 404 | `not_found`, `blob_not_found`, `version_not_found`, … | «Ничего не нашли по этому адресу» |
| Magic-ссылка мертва | 410 | `magic_link_expired` / `_used` / `_device_mismatch` | «Ссылка больше не действует. Прислать новую?» |
| ETag разошёлся | 412 | `etag_mismatch` | «Файл изменился на другом устройстве. Обновите его и попробуйте снова» |
| Тело больше лимита | 413 | `blob_too_large` | «Файл слишком большой для облака — предел 64 МБ» |
| Слишком много попыток | 429 | `too_many_attempts` | «Попробуйте через 30 секунд» |
| Внутренняя неполадка | 500 | `internal` | «Сейчас не получилось. Попробуйте ещё раз» |
| Оплата не настроена | 503 | `billing_unavailable` | «Оплата временно недоступна. Попробуйте позже» |
| Публикация выключена | 503 | `publish_disabled` | «Публикация по ссылке пока недоступна» |
| Квота исчерпана | 507 | `quota_exceeded` | «В облаке закончилось место. Удалите ненужные файлы или расширьте тариф» |

Тексты, которых в реестре `BEHAVIOR.md` §11 ещё нет, собраны отдельно в
`lib/messages.ts` → `PENDING_REGISTRY`. Они написаны по правилам §11 (без
восклицательных знаков, не винить пользователя, не употреблять слова
«ошибка»/«сбой»/«внимание») и являются кандидатами на внесение в реестр.

### Аккаунты

Паролей нет. SMS нет нигде — ни эндпоинта, ни поля, ни зависимости (прямой
запрет ТЗ §5.5; в схеме БД нет ни `password_hash`, ни `phone`, ни `otp`).

| Метод и путь | Тело / параметры | Ответ |
| --- | --- | --- |
| `POST /api/v1/auth/magic-link` | `{ email, deviceId, platform? }` | `202 { sent, message, expiresAt, resendAfterSeconds }` · `429`, если письмо уже уходило меньше 60 с назад |
| `GET /api/v1/auth/magic-link/callback` | `?token=&device_id=&format=json\|redirect` | `200 SessionResponse` либо редирект на `AUTH_SUCCESS_REDIRECT` · `410`, если токен просрочен, использован или пришёл с другого устройства |
| `GET /api/v1/auth/yandex` | `?device_id=&platform=` | `302` на OAuth Яндекса |
| `GET /api/v1/auth/yandex/callback` | `?code=&state=` | `200 SessionResponse` либо редирект |
| `POST /api/v1/auth/refresh` | `{ refreshToken }` | `200 SessionResponse` (refresh ротируется) · `401 session_expired` |
| `POST /api/v1/auth/logout` | `{ refreshToken }` | `204`, идемпотентно |
| `POST /api/v1/auth/logout-all` | — | `200 { revoked }` |
| `GET /api/v1/auth/me` | — | `200 { id, email, analyticsOptIn, createdAt, device }` |
| `POST /api/v1/auth/analytics-consent` | `{ optIn: boolean }` | `200 { analyticsOptIn }` |

`SessionResponse`:

```jsonc
{
  "accessToken": "<HS256 JWT>",
  "expiresIn": 900,                     // AUTH_ACCESS_TTL_SECONDS
  "refreshToken": "<opaque>",
  "refreshExpiresAt": "2026-10-08T…Z",
  "user": { "id": "uuid", "email": "…", "analyticsOptIn": false },
  "device": { "id": "uuid" }
}
```

Magic-токен: TTL 15 минут, **одноразовый**, привязан к устройству инициации; в
базе лежит только SHA-256 от него. Если письмо не ушло, токен немедленно
удаляется — чтобы пользователь мог повторить сразу, а не ждать минуту.

### Vault: манифест и блобы

| Метод и путь | Что делает |
| --- | --- |
| `GET /api/v1/vault/manifest?since=&includeDeleted=0\|1` | Список `{ path, etag, mtime, size }` + `quota: { usedBytes, limitBytes }`. С `includeDeleted=1` добавляется `removed: string[]` — надгробия для досинхронизации удалений |
| `GET /api/v1/vault/blob/<путь>` | Байты. `ETag`, `Last-Modified`, `Cache-Control: private, no-store`. `If-None-Match` → `304`. `404 blob_not_found` |
| `PUT /api/v1/vault/blob/<путь>` | Записать. Тело — `application/octet-stream`. Заголовки: `If-Match` (оптимистичная блокировка, `*` — «должен существовать»), `If-None-Match: *` («должен отсутствовать»), `X-Note-Id`, `X-Device-Name`, `X-Version-Merged`. Ответ `200 { path, etag, mtime, size }` |
| `DELETE /api/v1/vault/blob/<путь>` | Мягкое удаление (надгробие в БД, файл из тома сразу). `If-Match` поддерживается. `204` |

Путь — **в URL**, нормализуется и валидируется `normalizeVaultPath`: прямые
слэши, без ведущего, без `.`/`..`, без управляющих символов, ≤1024 символа,
сегмент ≤255, без хвостовых пробелов и точек (Windows-совместимость).

Правило доступа: **чтение доступно всегда**, ни один `GET` не спрашивает про
подписку. `PUT` требует действующей подписки (`assertCanWrite`). `DELETE`
разрешён и после истечения — иначе пользователь, упёршийся в квоту, оказался бы
заперт без выхода: ТЗ §5.5 запрещает запись новых данных, а не уборку своих.

При `PUT` с изменённым содержимым предыдущий шифротекст автоматически
уезжает в историю версий (если пришёл `X-Note-Id`). Байты не копируются:
адресация по содержимому, ключ тот же.

### Vault: CRDT-апдейты

| Метод и путь | Что делает |
| --- | --- |
| `POST /api/v1/vault/crdt/:noteId` | Принять апдейт(ы). Тело — либо сырые байты, либо `{"updates":["<base64>",…]}` (до 500 штук — экономит запросы, когда клиент досылает оффлайн-хвост). `201 { noteId, seq, accepted }` |
| `GET /api/v1/vault/crdt/:noteId?since=&limit=` | `200 { updates: CrdtUpdateEnvelope[], nextSince, hasMore }`. Курсор `seq` монотонный |

Сервер апдейты **не интерпретирует**: `ciphertext bytea` внутрь, `base64`
наружу.

### Vault: история версий

| Метод и путь | Что делает |
| --- | --- |
| `GET /api/v1/vault/versions/:noteId?limit=` | `200 { noteId, versions: RemoteVersionSnapshot[], retentionDays }`. Читать историю можно всегда, включая истёкшую подписку |
| `GET /api/v1/vault/versions/:noteId/:versionId` | Байты версии + `X-Version-Taken-At`, `X-Version-Source`, `X-Version-Merged` |
| `POST /api/v1/vault/versions/:noteId` | Явный снимок. Тело — зашифрованные байты. Заголовки `X-Vault-Path`, `X-Version-Source`, `X-Version-Merged` |

`RemoteVersionSnapshot` отличается от `VersionSnapshot` ядра одним полем: вместо
`body` (расшифрованный текст, существует только на клиенте) — `size` и `etag`.
Срок хранения проставляется **в момент записи** по действующему тарифу: 30 дней
пробный, 365 подписка. Смена тарифа не укорачивает задним числом то, что уже
сохранено.

### Vault: мгновенный синк

`GET /api/v1/vault/live` — websocket. Токен принимается заголовком или в query
(браузерный WebSocket не умеет ставить заголовки; в журнал токен не попадает).

Канал **односторонний**: сокет ничего не принимает, кроме прикладного `ping`, —
чтобы не заводить второй путь записи в обход HTTP с его проверками подписки и
квоты. Heartbeat 30 с. Коды закрытия: `4401` — не авторизован, `4403` — сессия
исчезла.

События (`LiveEvent`) содержат **только пути и идентификаторы**:

```jsonc
{ "type": "changed", "path": "Проекты/Идея.md.enc", "etag": "…", "mtime": 1, "origin": "device-uuid" }
{ "type": "removed", "path": "…", "origin": "…" }
{ "type": "crdt", "noteId": "…", "seq": 42, "origin": "…" }
```

`origin` — устройство-источник, чтобы клиент не реагировал на собственную
запись.

### Подписка

| Метод и путь | Что делает |
| --- | --- |
| `GET /api/v1/billing/status` | `BillingStatus`: план, статус, `canWrite`, даты периода/льготы/пробного, `quota`, `versionRetentionDays`, цены |
| `POST /api/v1/billing/trial` | Пробный период 14 дней. Без карты и без таймеров |
| `POST /api/v1/billing/cancel` | Отмена автопродления. Доступ — до конца оплаченного периода |
| `POST /api/v1/billing/yookassa/payment` | `{ plan: 'monthly'\|'yearly', returnUrl }` → `{ paymentId, status, confirmationUrl }` |
| `POST /api/v1/billing/yookassa/webhook` | Уведомление ЮKassa. Подпись HMAC-SHA256 **по сырым байтам** тела + опциональный список CIDR. После успешной проверки всегда `200`, даже на неизвестное событие, — иначе ЮKassa будет ретраить сутки |
| `POST /api/v1/billing/google-play/verify` | `{ purchaseToken, productId? }`. Сервер сам спрашивает Google Play Developer API: результату проверки на устройстве не доверяем |

Планы: `free` · `trial` · `monthly` · `yearly`. Статусы: `none` · `trial` ·
`active` · `grace` · `expired`. Цены по умолчанию — 199 ₽/мес и 149 ₽/мес при
годовой оплате, льготный период 7 дней.

Главное правило модуля: **истечение подписки не блокирует данные**. Считается
только `canWrite`; ни один эндпоинт чтения на него не смотрит.

### Публикация по ссылке

| Метод и путь | Что делает |
| --- | --- |
| `POST /api/v1/publish` | `{ html, title, lead?, noteId?, slug?, publishedAt? }` → `201 PublishedPageRef`. Требует подписки |
| `GET /api/v1/publish` | Список своих страниц |
| `DELETE /api/v1/publish/:slug` | Снятие публикации. Разрешено всегда: это уборка, а не запись |
| `GET /p/:slug` | Публичная страница, HTML |

HTML приходит **от клиента** (ключей у сервера нет) и потому считается
недоверенным вводом: проходит через белый список `lib/sanitizeHtml.ts`, страница
отдаётся с CSP без `script-src`. Сам документ лежит в томе, а не в колонке БД.

> ⚠️ `deploy/zapiski.cmpas.ru.nginx.conf` проксирует на API только `/api/`.
> Маршрут `/p/:slug` в vhost не описан и на продакшене попадёт в SPA-фолбэк.
> Публикация по ссылке — функция P1, к моменту её включения vhost нужно
> дополнить.

### Автообновление

`GET /api/v1/updates/:platform/:currentVersion` — фид в формате Tauri updater.

* `200` + `{ version, notes, pub_date, platforms }` — есть новее;
* **`204` без тела** — обновления нет. Именно так Tauri понимает «ничего
  нового»; отдавать `200` с той же версией нельзя — клиент начнёт скачивать то,
  что у него уже стоит.

Источник — JSON-файл в томе (`UPDATES_MANIFEST_PATH`), который кладёт релизный
пайплайн. Файла нет → `204`: отсутствие релиза не повод ронять запросы. Ключи
`platforms` сопоставляются точно и по префиксу (`windows` → `windows-x86_64`).
Сравнение версий — semver, предрелиз младше релиза.

### Здоровье

| Путь | Ответ |
| --- | --- |
| `GET /health` | `200 { status, uptimeSeconds, checks: { database, blobs } }` либо `503 degraded` |
| `GET /health/live` | `200 { status: 'ok' }` |

> ⚠️ **Расхождение.** `deploy/docker-compose.yml` (healthcheck) и
> `deploy/SETUP.md` требуют `GET /api/v1/health`, а сервер отдаёт `/health`.
> В таком виде контейнер `zapiski-api` никогда не станет `healthy`, и деплой
> упадёт по таймауту. Чинится в одну строку — либо в compose, либо добавлением
> алиаса в `routes/health.ts`.

---

## Схема БД

Три миграции, накатываются автоматически при старте (`runMigrations` в
`src/index.ts`) и вручную через `npm run migrate`.

### `0001_accounts.sql`

| Таблица | Ключевые поля |
| --- | --- |
| `users` | `id`, `email` (уникален по `lower(email)`), `email_verified_at`, `yandex_id`, `analytics_opt_in` (по умолчанию **false**), `deleted_at`. Ни `password_hash`, ни `phone`, ни `otp` |
| `devices` | `user_id`, `device_key` (генерирует клиент), `platform`, `last_seen_at`. Человекочитаемое имя устройства **не хранится** |
| `magic_tokens` | `email`, `token_hash` (SHA-256, сам токен не хранится), `device_key`, `expires_at`, `used_at` |
| `sessions` | `user_id`, `device_id`, `refresh_token_hash`, `expires_at`, `revoked_at`, `revoked_reason` |

### `0002_vault.sql`

| Таблица | Ключевые поля |
| --- | --- |
| `blobs` | `user_id`, `path`, `path_hash`, `etag` (SHA-256 шифротекста), `size`, `mtime`, `storage_key`, `deleted_at` (мягкое удаление). Уникально `(user_id, path)` |
| `crdt_updates` | `seq bigserial` (курсор для `?since=`), `note_id`, `ciphertext bytea`, `size`, `device_id` |
| `versions` | `note_id`, `path`, `storage_key`, `etag`, `size`, `source`, `merged`, `taken_at`, `expires_at` |
| `quota_usage` | `blob_bytes`, `version_bytes`, `crdt_bytes`, `published_bytes`, `blob_count` — обновляется **в той же транзакции**, что запись/удаление, поэтому не расходится с фактом |

### `0003_billing_publish.sql`

| Таблица | Ключевые поля |
| --- | --- |
| `subscriptions` | `plan`, `status`, даты пробного/периода/льготы, `provider`, `auto_renew` |
| `billing_events` | `(provider, event_id)` уникально — идемпотентность вебхуков |
| `published_pages` | `slug`, `storage_key`, `content_hash`, `size`, `revoked_at` |

### Том блобов

`BlobStore` (`services/blobStore.ts`), три свойства:

1. **Атомарность** — запись во временный файл рядом, `fsync`, `rename`.
2. **Адресация по содержимому** — ключ = SHA-256 шифротекста. Отсюда:
   запись идемпотентна, старый шифротекст не затирается новым, а снимок в
   историю версий **не требует копирования байтов**.
3. **Имена в томе не повторяют имена в vault'е** — из листинга каталога нельзя
   узнать ни одного заголовка. Дедупликация — только внутри одного аккаунта:
   общий на всех том выдал бы, что у двух людей совпал файл.

Файл удаляется из тома только когда на его ключ не осталось ссылок ни из
`blobs`, ни из `versions`, и только **после** коммита транзакции.

---

## Конфигурация

Всё из окружения, секретов в коде нет. Схема — `src/config/env.ts` (zod,
падение при неверном значении). Значения по умолчанию для продакшена —
`deploy/docker-compose.yml`, секреты — `deploy/.env` (образец:
`deploy/.env.example`).

| Переменная | По умолчанию | Комментарий |
| --- | --- | --- |
| `PORT` / `HOST` | `3100` / `0.0.0.0` | ADR-0003 §2 |
| `DATABASE_URL` | — | Обязательна |
| `AUTH_SECRET` | — | HS256, **минимум 32 символа**; смена разлогинивает всех |
| `AUTH_ACCESS_TTL_SECONDS` | 900 | |
| `AUTH_REFRESH_TTL_SECONDS` | 60 дней | |
| `MAGIC_LINK_TTL_SECONDS` | 900 | ТЗ §5.5 — 15 минут |
| `MAGIC_LINK_COOLDOWN_SECONDS` | 60 | SCREENS §2 — «Отправить снова» неактивна 60 с |
| `BLOB_ROOT` | `/data/blobs` | Том с шифротекстом |
| `SMTP_HOST` / `SMTP_PORT` | `localhost` / 25 | Существующий postfix, ADR-0003 §7 |
| `MAIL_FROM` | `ЗАПИСКИ <zapiski@cmpas.ru>` | Домен обязан быть `cmpas.ru` |
| `QUOTA_BYTES` | 10 ГиБ | ТЗ §7 |
| `MAX_BLOB_BYTES` / `MAX_CRDT_BYTES` / `MAX_PUBLISHED_BYTES` | 64 / 4 / 2 МиБ | |
| `VERSION_RETENTION_TRIAL_DAYS` / `_PAID_DAYS` | 30 / 365 | ТЗ §4.2 |
| `TRIAL_DAYS` / `GRACE_DAYS` | 14 / 7 | |
| `PRICE_MONTHLY_RUB` / `PRICE_YEARLY_MONTHLY_RUB` | 199 / 149 | |
| `YANDEX_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | — | Не заданы → вход через Яндекс ID выключен, вход по почте работает |
| `YOOKASSA_*`, `GOOGLE_PLAY_*` | — | Не заданы → `503 billing_unavailable` |
| `UPDATES_MANIFEST_PATH` | — | Не задан → фид обновлений отвечает `204` |
| `PUBLISH_ENABLED` | `true` | |
| `ANALYTICS_ENABLED` | `false` | ТЗ §6: аналитика opt-in |
| `CORS_ORIGINS` | — | Пусто → CORS выключен |
| `TRUST_PROXY` | `true` | Сервер за nginx |

Фоновая уборка раз в час: просроченные версии и отработавшие magic-токены.

## Заметка о типах протокола

`server/src/protocol.ts` объявляет типы **структурно идентично**
`packages/core/src/contract.ts`, а совпадение проверяет
`test/contract.conformance.test.ts`: он читает файл ядра и падает, если набор
полей разошёлся.

Почему не прямой импорт, хотя ADR-0003 обещает «один контракт»: `packages/core`
принадлежит другой команде и на момент написания не собирается как npm-пакет;
прямой импорт сделал бы сборку сервера заложником чужого дерева. Тест даёт ту же
гарантию «рассинхрон ломает CI», не ломая сборку.

> ⚠️ Гарантия оказалась не полной: совпадают **поля DTO**, но не **пути
> эндпоинтов**. `VAULT_ENDPOINTS` в ядре описывает другой набор адресов, чем
> реализовал сервер — подробности и таблица расхождений в
> [core.md](core.md#протокол-облака). До сведения к одному источнику клиент
> `KompasCloudBackend` к этому серверу не подключится.
