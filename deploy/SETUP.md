# Развёртывание КОМПАС.ЗАПИСОК на cmpas.ru

ЗАПИСКИ живут на том же сервере, что и **работающий КОМПАС.Дневник**.
Всё, что здесь описано, подчинено одному правилу: Дневник не должен заметить,
что рядом что-то появилось. Инварианты изоляции — в
[`docs/adr/0003-backend-na-node-i-izolyaciya-na-cmpas-ru.md`](../docs/adr/0003-backend-na-node-i-izolyaciya-na-cmpas-ru.md),
каждый из них прокомментирован прямо в коде этого каталога.

| Что | Дневник | ЗАПИСКИ |
| --- | --- | --- |
| Домен | `cmpas.ru`, `moments.cmpas.ru` | `zapiski.cmpas.ru` |
| Docroot | `/var/www/cmpas.ru` | `/var/www/zapiski.cmpas.ru` |
| Рабочая копия | `/var/www/cmpas.ru` | `/var/www/zapiski` |
| Порт приложения | 3000 | **3100, только на 127.0.0.1** |
| Compose-проект | свой | `zapiski` |
| Контейнеры | `cmpas-app`, `cmpas-postgres`, `cmpas-mailer` | `zapiski-api`, `zapiski-postgres` |
| Тома | свои | `zapiski_db_data`, `zapiski_blobs` |
| Почта | postfix, порт 25 | **тот же postfix**, своего нет |

---

## 1. Что человек делает руками — ОДИН раз

Автоматика не может сделать ровно четыре вещи. Всё остальное сделают workflow'ы.

### 1.1. DNS

Завести **A-запись** у регистратора домена `cmpas.ru`:

```
zapiski   A   <IP сервера cmpas.ru>
```

IP — тот же, что у `cmpas.ru` и `moments.cmpas.ru` (посмотреть можно
`dig +short cmpas.ru`). Пока записи нет, certbot выпустить сертификат не
сможет — сайт будет работать по HTTP, а провижн честно об этом напишет
в лог и не упадёт.

Проверка: `dig +short zapiski.cmpas.ru` возвращает тот же адрес, что и
`dig +short cmpas.ru`.

### 1.2. Секреты доступа к серверу

Скопировать в **Settings → Secrets and variables → Actions** этого репозитория
три секрета из репозитория `compas-psy/cmpas.ru`:

| Секрет | Что это |
| --- | --- |
| `SERVER_HOST` | адрес сервера |
| `SERVER_USER` | пользователь SSH (имеет root: workflow пишет в `/etc/nginx` и делает `systemctl`) |
| `SSH_PRIVATE_KEY` | приватный ключ для этого пользователя, целиком, вместе со строками `-----BEGIN…` / `-----END…` |

**Значения секретов нельзя прочитать ни через API, ни через UI, ни агентом** —
GitHub отдаёт их только раннеру во время исполнения. Скопировать может лишь
тот, у кого они есть локально (владелец сервера). Это не ограничение
инструмента, а требование безопасности: механизм устроен так, чтобы
утёкший доступ к репозиторию не означал утёкший доступ к серверу.

### 1.3. Доступ сервера к этому репозиторию

Провижн клонирует репозиторий в `/var/www/zapiski`. Если репозиторий
приватный, анонимный HTTPS-клон не пройдёт — нужен deploy key. Один раз:

```bash
ssh <SERVER_USER>@<SERVER_HOST>
ssh-keygen -t ed25519 -C 'zapiski-deploy' -f ~/.ssh/id_ed25519 -N ''   # если ключа ещё нет
cat ~/.ssh/id_ed25519.pub
```

Публичный ключ добавить в **Settings → Deploy keys** репозитория
`compas-psy/zapiski` (доступ **read-only**, «Allow write access» не нужен).

Провижн сначала пробует HTTPS, потом SSH и, если не вышло, печатает эти же
шаги в лог и останавливается — nginx и TLS к тому моменту уже настроены,
Дневник не затронут.

### 1.4. Остальные секреты

Нужны по мере готовности функций; workflow'ы не падают, если их ещё нет.

| Секрет | Для чего | Когда понадобится |
| --- | --- | --- |
| `YANDEX_CLIENT_ID` | Яндекс ID (OAuth) — основной способ входа, ТЗ §5.5 | вместе с аккаунтами |
| `YANDEX_CLIENT_SECRET` | там же | вместе с аккаунтами |
| `TAURI_SIGNING_PRIVATE_KEY` | подпись автообновлений Tauri; без неё апдейтер отклонит пакет | первый релиз desktop |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | пароль к этому ключу | там же |
| `ANDROID_KEYSTORE_BASE64` | keystore подписи APK в base64 (`base64 -w0 zapiski-release.jks`) | первый релиз Android |
| `ANDROID_KEYSTORE_PASSWORD` | пароль хранилища | там же |
| `ANDROID_KEY_ALIAS` | алиас ключа внутри keystore | там же |
| `ANDROID_KEY_PASSWORD` | пароль ключа | там же |

Про Android-подпись: **алиас и keystore менять нельзя после первой публикации**
— обновление с другой подписью не встанет поверх установленного приложения,
пользователю придётся удалять и ставить заново, теряя данные приложения.

Яндекс ID: в консоли приложения (`oauth.yandex.ru`) Redirect URI должен
совпадать с `YANDEX_REDIRECT_URI` из `deploy/.env` —
`https://zapiski.cmpas.ru/api/v1/auth/yandex/callback`.

---

## 2. Порядок запуска

Строго в этом порядке. Оба workflow'а делят группу concurrency
`zapiski-server`, поэтому одновременно на сервер они не пойдут при всём
желании.

### Шаг 1 — «Провижн zapiski.cmpas.ru (nginx + TLS)»

Actions → *Провижн zapiski.cmpas.ru* → **Run workflow**.
(Запускается и сам, при изменениях в `deploy/**` в ветке `main`.)

Что делает:

1. проверяет синтаксис vhost в контейнере `nginx -t` — **до** отправки на сервер;
2. создаёт `/var/www/zapiski.cmpas.ru` и `/var/www/zapiski.cmpas.ru/updates`;
3. кладёт vhost в `sites-available`, делает симлинк, `nginx -t`, и
   `systemctl reload nginx` **только при успехе**; при провале снимает симлинк;
4. выпускает сертификат `certbot --nginx -d zapiski.cmpas.ru` — строго один
   домен, только если сертификата ещё нет;
5. клонирует репозиторий в `/var/www/zapiski`.

Признак успеха: `curl -I http://zapiski.cmpas.ru` отвечает (404 — нормально,
статики ещё нет), а `nginx -t` на сервере зелёный.

### Шаг 2 — «Деплой zapiski.cmpas.ru»

Идёт автоматически на каждый push в `main`. Что делает:

* `preflight` — типы, линт токенов, тесты, сборка PWA, валидация
  `docker-compose.yml` и vhost;
* `deploy` — rsync `apps/web/dist` в docroot (каталог `updates/` исключён,
  релизные бинарники деплоем веба не сносятся), затем `git reset --hard` в
  `/var/www/zapiski` и запуск `deploy/deploy-production-remote.sh`.

При провале удалённый лог `/tmp/zapiski-deploy.log` приезжает артефактом
`zapiski-deploy-<sha>` — там же будут `docker logs zapiski-api`.

---

## 3. Что должно быть на месте, чтобы деплой прошёл

Пайплайн готов раньше кода — это нормально. Прежде чем `deploy` станет
зелёным, нужны:

| Что | Кто владеет | Зачем деплою |
| --- | --- | --- |
| `server/src/index.ts` + `npm run build` | бэкенд | образ `zapiski-api` собирается из `deploy/api.Dockerfile` |
| `GET /api/v1/health` → 2xx | бэкенд | по нему устроен healthcheck в `docker-compose.yml`; без него деплой честно упадёт по таймауту |
| `apps/web` со скриптом `build`, результат в `apps/web/dist` | веб | иначе шаг сборки PWA пропускается, статика не выкладывается |

`npm run migrate` в `server/package.json` уже есть — скрипт деплоя вызывает
его через `--if-present`, так что появление и исчезновение скрипта деплой
не ломает, а вот ошибка внутри миграции ломает, и правильно.

---

## 4. Откат

Всё сделано так, чтобы откат был двумя командами и Дневник о нём не узнал.

**Убрать сайт из nginx** (docroot и сертификат остаются на месте):

```bash
rm -f /etc/nginx/sites-enabled/zapiski.cmpas.ru
nginx -t && systemctl reload nginx      # reload только при зелёном тесте
```

**Погасить API-стек** (данные в томах остаются):

```bash
cd /var/www/zapiski
docker compose -f deploy/docker-compose.yml down
```

Проверить, что Дневник жив: `docker ps | grep cmpas-app` — контейнер на месте,
`curl -I https://cmpas.ru` отвечает.

**Полное удаление, с данными** — только осознанно, восстановления не будет:

```bash
cd /var/www/zapiski
docker compose -f deploy/docker-compose.yml down -v   # -v сносит zapiski_db_data и zapiski_blobs
rm -f /etc/nginx/sites-enabled/zapiski.cmpas.ru
nginx -t && systemctl reload nginx
```

`down -v` ограничен проектом `zapiski`: тома Дневника помечены другим
проектом, и эта команда их не видит.

---

## 5. Частые случаи

**certbot не выпустил сертификат.** Провижн это не валит: сайт остаётся на
HTTP. Проверьте A-запись (§1.1) и перезапустите провижн — он идемпотентен.

**Провижн переписал vhost, и TLS пропал.** Перезапись `sites-available`
снимает строки, которые дописывал certbot. Провижн замечает это и делает
`certbot --reinstall` сам. Если не помогло — руками:
`certbot --nginx -d zapiski.cmpas.ru --reinstall`.

**`nginx -t` не проходит.** Симлинк ЗАПИСОК снимается автоматически, reload
не выполняется, `sites-enabled` остаётся в состоянии, которое заведомо
проходит тест. Дневник продолжает работать на старом конфиге — nginx его
даже не перечитывал.

**Потерян `deploy/.env`, но том базы цел.** Новый сгенерированный пароль не
подойдёт к уже инициализированной базе. Лечится изнутри контейнера:

```bash
docker exec -it zapiski-postgres psql -U zapiski -d zapiski   # если ещё пускает
# либо, если не пускает, сменить пароль от имени суперпользователя:
docker exec -it zapiski-postgres psql -U postgres -c "ALTER USER zapiski WITH PASSWORD '<новый из deploy/.env>';"
```

**Письма не уходят.** Проверьте, что отправитель в домене `cmpas.ru` —
у postfix Дневника `ALLOWED_SENDER_DOMAINS: cmpas.ru`, чужой домен он
отклонит. Проверить связность из контейнера:
`docker exec zapiski-api node -e "require('net').connect(25,'172.17.0.1').on('connect',()=>console.log('ok')).on('error',e=>console.log(e.message))"`.
Если адрес шлюза docker0 другой — поправьте `EMAIL_SERVER_HOST` в
`deploy/.env` (можно `host.docker.internal`) и перезапустите деплой.

**Нужно выложить обновление desktop/Android.** Файлы кладутся в
`/var/www/zapiski.cmpas.ru/updates/` (`latest.json`, `*.msi`, `*.apk`,
`*.sig`). Обычный деплой веба их не трогает: rsync исключает `updates/`.
`latest.json` отдаётся с `no-cache`, бинарники — с часовым кэшем.
