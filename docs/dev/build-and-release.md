# Сборка и релиз

Как собираются веб, Windows и Android, какие workflow'ы за что отвечают, как
работает автообновление и какие секреты для этого нужны.

> **Честное состояние на 0.1.0.** Конвейеров пять: сервер и статика
> (`deploy-zapiski.yml` + `provision-zapiski.yml`), установщик Windows
> (`build-windows.yml`), APK Android (`build-android.yml`) и проверки инфобеза
> (`security.yml`). Ни один клиентский артефакт **ещё ни разу не собран и не
> запущен**: Windows-тулчейна и Android SDK в разработке нет, релизных тегов не
> ставили. Описанное ниже — это то, что делает код workflow'ов, а не отчёт об
> успешных прогонах.

---

## Веб (PWA)

`apps/web` — тонкая оболочка на Vite: монтирует `<App/>` из `packages/app` и
даёт реализацию `VaultStorage` поверх File System Access API (Chromium) или
OPFS (остальные браузеры). Продуктовой логики в оболочке нет ни строки —
правило [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §1.

```bash
pnpm build                              # packages/** + @zapiski/web
pnpm --filter "@zapiski/web..." build   # именно так это делает CI: пакет со своими зависимостями по графу
pnpm dev                                # Vite, http://localhost:5173
```

Результат — `apps/web/dist` (~1.5 с на сборку). Job `preflight` кладёт его
артефактом `zapiski-web-dist`, job `deploy` выкладывает rsync'ом в
`/var/www/zapiski.cmpas.ru`.

Что оболочка делает, кроме монтирования:

* вставляет инлайном `themeInitScript` из `@zapiski/ui` первым в `<head>` —
  иначе первый кадр мигнёт светлым. Строка берётся из публичного API пакета,
  копии в оболочке нет; плагин сборки собирает пакет esbuild'ом с заглушкой
  CSS, потому что Node не умеет импортировать `.css`;
* отдаёт `manifest.webmanifest` и `sw.js` из `public/` (в vhost для них уже
  прописан `no-cache`);
* реализует `PdfRenderer` печатью скрытого iframe;
* реализует `BiometricProvider` через WebAuthn-PRF, если браузер и устройство
  умеют, иначе возвращает `null` — и UI **скрывает** тумблер биометрии, а не
  показывает его выключенным.

Сборка печатает предупреждение Vite о чанке больше 500 КБ: главный бандл — ~648
КБ (~205 КБ в gzip), туда попадают CodeMirror и всё приложение. Подсветка
языков кода уже вынесена в динамические чанки. Бюджета на размер веб-бандла в
ТЗ нет.

Подробности по портам — [modules/platforms.md](modules/platforms.md#веб-appsweb).

## Windows (Tauri 2)

`apps/desktop` — оболочка Tauri 2. Собирается **только в CI на раннере
`windows-latest`**: Windows-тулчейна в разработке нет, это зафиксировано в
[`../ACCEPTANCE.md`](../ACCEPTANCE.md).

Локально (на Windows-машине):

```bash
pnpm --filter @zapiski/desktop typecheck
pnpm --filter @zapiski/desktop build      # только фронтенд (vite build)
pnpm --filter @zapiski/desktop tauri dev
pnpm --filter @zapiski/desktop tauri build --target x86_64-pc-windows-msvc
```

Что даёт оболочка: `VaultStorage` поверх `@tauri-apps/plugin-fs` с **атомарной
записью в Rust**, Windows Hello, глобальный хоткей (по умолчанию `Ctrl+Alt+N`),
трей с переключателем автозапуска, ассоциация `.md`/`.markdown`, единственный
экземпляр приложения, печать в PDF через WebView2, автообновление.

Бандлы: **NSIS** (`-setup.exe`, им ставится обновление, `installMode: passive`)
и **MSI** (для развёртывания политиками домена). Бюджет ТЗ §6 — installer
< 25 МБ — проверяется отдельным шагом workflow, а не надеждой.

> ⚠️ В `apps/desktop/src-tauri/tauri.conf.json` в `plugins.updater.pubkey`
> стоит заглушка `ЗАМЕНИТЬ-НА-НАСТОЯЩИЙ-ПУБЛИЧНЫЙ-КЛЮЧ`. Пара ключей
> генерируется один раз командой
> `pnpm --filter @zapiski/desktop tauri signer generate`: публичная половина
> кладётся в конфиг, приватная — **только** в секрет репозитория
> `TAURI_SIGNING_PRIVATE_KEY`. Workflow проверяет и наличие секрета, и заглушку
> в конфиге, и падает с объяснением: с ключом-заглушкой сборка прошла бы, а
> автообновление молча не работало бы у пользователей.

## Android (Tauri 2 Mobile)

`apps/mobile` — оболочка Tauri 2 Mobile. Собирается **только в CI**: Android
SDK и NDK в разработке нет.

```bash
pnpm -r --filter "./packages/**" build
pnpm --filter @zapiski/mobile typecheck
pnpm --filter @zapiski/mobile build:vite                 # фронтенд → apps/mobile/dist
pnpm --filter @zapiski/mobile android:overlay:selftest   # проверка патча манифеста без SDK

pnpm --filter @zapiski/mobile exec tauri android init    # генерирует gen/android
pnpm --filter @zapiski/mobile android:overlay            # накладывает Kotlin и патчит манифест
pnpm --filter @zapiski/mobile exec tauri android build --apk
```

**Порядок обязателен.** `src-tauri/gen/android` — сгенерированный проект
Gradle, он в `.gitignore`; в git лежит только оверлей `apps/mobile/android/**`,
который накладывает `scripts/apply-android-overlay.mjs`. Он же патчит
`AndroidManifest.xml` по маркерам: разрешения, share-target, плитка Quick
Settings, `FileProvider`, провайдеры виджетов. Обоснование — в шапке скрипта и
в [modules/platforms.md](modules/platforms.md#оверлей-вместо-genandroid-в-git).

Ещё одна тонкость порядка: `cargo check`/`cargo build` в `src-tauri` требуют
существующего `../dist` — кодогенерация Tauri читает `frontendDist`. Сначала
`build:vite`, потом Rust.

**Про подпись — важное.** Алиас и keystore **нельзя менять после первой
публикации**: обновление с другой подписью не встанет поверх установленного
приложения, пользователю придётся удалять и ставить заново, теряя данные.
Пока секретов `ANDROID_KEYSTORE_*` нет, workflow собирает **debug-APK** и
печатает notice: он ставится на устройство, но релизом не является.

Что не закрыто и не может быть закрыто здесь: **риск-зона №1** из ТЗ §2.2 —
качество WebView-редактора на Android (IME, Gboard / Яндекс.Клавиатура /
SwiftKey, автозамена, свайп-ввод, кириллица). Защита в коде написана
([modules/editor.md](modules/editor.md#проблема-ime)), но подтверждать её
придётся на реальных устройствах.

Остальные незакрытые концы — [modules/platforms.md](modules/platforms.md#android-что-осталось).

---

## Workflow'ы

В репозитории их пять, все с комментариями по-русски прямо в файлах.

| Файл | Когда идёт | Что делает |
| --- | --- | --- |
| `provision-zapiski.yml` | Вручную и на изменения в `deploy/**` в `main` | Разовая подготовка сервера: docroot, vhost, TLS |
| `deploy-zapiski.yml` | Каждый push в `main` (кроме `docs/**` и `*.md`) и каждый PR | Проверки, сборка PWA, выкладка статики и API |
| `build-windows.yml` | Теги `v*`, PR по `apps/desktop/**` и `packages/**`, вручную | Установщик Windows; на теге — GitHub Release и выкладка обновления |
| `build-android.yml` | Теги `v*`, PR по `apps/mobile/**` и `packages/**`, вручную | APK; на теге — GitHub Release и выкладка APK с манифестом |
| `security.yml` | Push в `main`, каждый PR (включая форки), еженедельно | Проверки инфобеза |

Все job'ы, которые трогают сервер, делят группу concurrency `zapiski-server` с
`cancel-in-progress: false`: начатую выкладку на прод не обрывают, и
одновременно сервер трогает кто-то один.

### `provision-zapiski.yml` — «Провижн zapiski.cmpas.ru (nginx + TLS)»

**Выполняется один раз перед первым деплоем.**

1. Проверяет синтаксис vhost локально, в контейнере `nginx -t` — **до** отправки
   на сервер.
2. Создаёт `/var/www/zapiski.cmpas.ru` и `.../updates`.
3. Кладёт vhost в `sites-available`, делает симлинк, `nginx -t`, и
   `systemctl reload nginx` **только при успехе**; при провале снимает симлинк.
4. Выпускает сертификат certbot'ом. Домена два: канонический
   `zapiski.cmpas.ru` и псевдоним `notes.cmpas.ru`, который отдаёт **301 на
   канонический** — иначе редирект был бы на голом HTTP.
5. Клонирует репозиторий в `/var/www/zapiski`.

### `deploy-zapiski.yml` — «Деплой zapiski.cmpas.ru»

На pull request выполняется только `preflight`.

**Job `preflight`** (раннер `ubuntu-latest`, Node 22, pnpm):

1. `pnpm install` (`--frozen-lockfile`, если есть lock-файл);
2. определяет состав воркспейса скриптом и включает следующие шаги по факту;
3. `pnpm -r typecheck`;
4. `pnpm run lint:tokens` — инвариант «ни одного hex вне токенов»;
5. `pnpm -r test`;
6. сборка PWA (`pnpm --filter "@zapiski/web..." build`) → артефакт
   `zapiski-web-dist`;
7. `docker compose config --quiet` — битый YAML обнаружится здесь, а не на проде
   в момент `up -d`;
8. `nginx -t` для vhost в контейнере;
9. `bash -n` для скрипта удалённого деплоя.

**Job `deploy`** (только push в `main`):

1. забирает артефакт статики;
2. проверяет, что провижн уже выполнен (есть docroot и рабочая копия);
3. rsync статики в docroot с `--delete`, исключая `updates/` и `.well-known/`;
4. доставляет код API на сервер rsync'ом (репозиторий приватный, клонировать
   его на сервере значило бы держать там deploy key с правом чтения всего);
5. поднимает стек `docker compose` проекта `zapiski`;
6. при провале скачивает `/tmp/zapiski-deploy.log` и прикладывает артефактом
   `zapiski-deploy-<sha>`.

Секреты уезжают на сервер **одним base64-блобом**, а не отдельными аргументами:
апостроф или `;` внутри значения иначе исполнился бы как код, а пустой аргумент
схлопнулся бы при склейке ssh-команды и сдвинул позиции.

> ⚠️ **Известный дефект деплоя.** Healthcheck API в `deploy/docker-compose.yml`
> опрашивает `http://127.0.0.1:3100/api/v1/health`, а сервер отдаёт `/health`
> (плюс `/health/live`) — без префикса `/api/v1`
> (`server/src/routes/health.ts`). Контейнер никогда не станет `healthy`, и
> зависящие от него шаги упадут по таймауту. Чинится в одну строку с любой из
> двух сторон; выбор за владельцем сервера.

### `build-windows.yml` — «Сборка Windows»

**Job `build`** (`windows-latest`, до 60 минут, кэш pnpm store и cargo):

1. `pnpm install`;
2. `pnpm -r --filter "./packages/**" build`;
3. `pnpm --filter @zapiski/desktop typecheck` — отдельным шагом, потому что
   Vite типы не проверяет, он их стирает;
4. `pnpm --filter @zapiski/desktop build` — тоже отдельно, чтобы ошибка
   фронтенда была видна сразу, а не искалась в километровом логе cargo;
5. **проверка ключей подписи** — см. предупреждение выше;
6. `tauri build --target x86_64-pc-windows-msvc`;
7. сборка `latest.json` скриптом: NSIS-установщик и `.sig` переименовываются в
   латиницу (бандлер называет файл по `productName`, а он кириллический —
   такое имя уехало бы в URL в percent-encoded виде), подпись читается из
   `.sig`, считается SHA-256 и размер;
8. **проверка бюджета ТЗ §6**: installer < 25 МБ, иначе ошибка;
9. на теге — сверка тега с `version` из `tauri.conf.json`: иначе апдейтер
   предложил бы пользователям версию, которой нет в манифесте;
10. артефакт `zapiski-windows-<версия>`.

**Job `release`** (только на теге `v*`, `ubuntu-latest`):

1. GitHub Release (идемпотентно: повторный запуск на том же теге не падает);
2. по ssh — `scp` установщика, `.sig` и `.msi` в
   `/var/www/zapiski.cmpas.ru/updates/`, **`latest.json` последним**. Порядок не
   косметический: манифест ссылается на файл, и клиент, увидевший новый
   `latest.json` раньше самого `.exe`, получил бы 404;
3. контрольный запрос к фиду с заведомо старой версией — предупреждение, если
   ответ не `200`.

Ничего не удаляется: `rsync --delete` здесь не используется, nginx не
трогается вовсе.

### `build-android.yml` — «Сборка Android»

**Job `build`** (`ubuntu-latest`: JDK 21, Android SDK, NDK, Rust с
Android-таргетами, кэш cargo и pnpm store):

1. `pnpm install`, сборка `packages/**`;
2. `pnpm --filter @zapiski/mobile typecheck` и сборка фронтенда;
3. тесты Rust-части оболочки;
4. **самопроверка оверлея** — патч манифеста прогоняется на эталонном файле и
   валидируется `xmllint`, без Android SDK;
5. `tauri android init` → `android:overlay` → `tauri android build`;
6. подготовка keystore: есть секреты `ANDROID_KEYSTORE_*` — релизная подпись;
   нет — debug-APK с явным notice в логе, что это не релиз;
7. бюджет ТЗ §6 (APK < 30 МБ) проверяется, но **не роняет сборку**: печатается
   `::warning::`. В отличие от Windows, где превышение бюджета — ошибка.

**Job `release`** (только на теге `v*`): GitHub Release, затем по ssh — APK и
`latest.json` в `/var/www/zapiski.cmpas.ru/updates/`. APK кладётся под
временным именем и переименовывается: клиент, скачавший файл в момент выкладки,
не должен получить половину.

### `security.yml` — «Безопасность»

Отделён от деплоя намеренно: проверки обязаны идти на каждый PR, **включая PR
из форка**, где секретов нет и деплой не запускается. Внешних экшенов, кроме
checkout/setup, здесь нет — сканер секретов написан своими силами: этот workflow
сторожит цепочку поставки, и тянуть в него стороннее действие с правом читать
дифф значило бы расширять ту самую поверхность, которую он проверяет.

На PR сканер смотрит только добавленные строки диффа (иначе один старый ложняк
красит все последующие сборки), на push и по расписанию — всё дерево.
Уязвимости в зависимостях появляются без наших коммитов, поэтому есть
еженедельный запуск по cron.

Разбор находок и статусы — [`security/AUDIT.md`](security/AUDIT.md), модель
угроз — [`security/THREAT-MODEL.md`](security/THREAT-MODEL.md). Оба документа
принадлежат инфобезу и этой командой не редактируются.

### Изоляция от КОМПАС.Дневника

Сервер `cmpas.ru` — действующий продакшен Дневника. Главный риск этого этапа —
не выбор технологии, а **уронить работающий Дневник**, поэтому:

* nginx в обычном деплое **не упоминается вообще**;
* rsync пишет строго в `/var/www/zapiski.cmpas.ru`; каталог `/var/www/cmpas.ru`
  не встречается ни в одном файле деплоя;
* `deploy-production-remote.sh` начинается с проверки «а туда ли меня
  запустили», и каждая изменяющая docker-команда явно привязана к
  compose-проекту `zapiski`;
* контейнер Дневника упоминается ровно один раз, в самом конце, и только в
  `docker inspect` — чтобы записать в лог, что он как работал, так и работает.

Полные правила — [ADR-0003](../adr/0003-backend-na-node-i-izolyaciya-na-cmpas-ru.md)
и [`../../deploy/SETUP.md`](../../deploy/SETUP.md).

---

## Автообновление

**Схема.** Клиент (Tauri updater) ходит на
`https://zapiski.cmpas.ru/api/v1/updates/{{target}}/{{current_version}}`.
Сервер читает JSON-манифест из тома (`UPDATES_MANIFEST_PATH`) и отвечает:

* `200` + манифест — если в манифесте версия новее текущей;
* **`204` без тела** — если новее нет. Это единственный способ сказать Tauri
  «обновления нет»; `200` с той же версией заставил бы клиента качать то, что
  уже установлено.

Tauri зовёт эндпоинт с `{{target}}` (`windows`), а ключи в манифесте —
`windows-x86_64`, поэтому `selectPlatforms` принимает и точное совпадение, и
префикс. Оболочка Windows настроена на `.../updates/windows/{{current_version}}`
и это работает; Android-оболочка спрашивает `.../updates/android/{{version}}`.

Манифест:

```jsonc
{
  "version": "0.2.0",
  "notes": "Что изменилось",
  "pub_date": "2026-09-01T10:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<подпись Tauri>", "url": "https://zapiski.cmpas.ru/updates/zapiski-0.2.0-x64-setup.exe" },
    "android-universal": { "signature": "", "url": "https://zapiski.cmpas.ru/updates/zapiski-0.2.0.apk" }
  }
}
```

Для Android подписи Tauri нет — встроенный апдейтер там не работает, APK ставит
системный установщик пакетов с согласия пользователя. Поэтому `signature`
пустая, а nginx отдаёт `.apk` с
`Content-Type: application/vnd.android.package-archive` (без него установщик
пакета не запустится, браузер просто покажет файл).

Файлы релиза кладутся в `/var/www/zapiski.cmpas.ru/updates/`. Кэширование в
vhost: `latest.json` — `no-cache` (иначе клиент неделю не узнает о релизе),
бинарники — час. `try_files … =404` принципиален: апдейтер должен получить
честный 404, а не HTML SPA-фолбэка.

**Состояние:** конвейеры описаны для обеих платформ — от тега до файла в
`updates/`. Ни один ни разу не отработал: релизных тегов не ставили. Пока в
томе нет файла, фид честно отвечает `204`, и это корректное поведение «релизов
ещё не было», а не поломка.

> ⚠️ **Асимметрия, о которой нужно знать.** `latest.json` один на обе
> платформы. Android-релиз это учитывает: он забирает текущий манифест с
> сервера и **доливает** свою запись, сохраняя `windows-x86_64` той же версии.
> Windows-релиз собирает манифест с нуля и запись `android-universal`
> **затрёт**. Поэтому при релизе одной версии на две платформы порядок имеет
> значение: сначала Windows, потом Android. На момент 0.1.0 это не проверено —
> релизов ещё не было.

---

## Секреты

Кладутся в **Settings → Secrets and variables → Actions** репозитория.

### Обязательные для деплоя

| Секрет | Что это |
| --- | --- |
| `SERVER_HOST` | Адрес сервера |
| `SERVER_USER` | Пользователь SSH (имеет root: workflow пишет в `/etc/nginx` и делает `systemctl`) |
| `SSH_PRIVATE_KEY` | Приватный ключ целиком, вместе со строками `-----BEGIN…`/`-----END…` |

Значения секретов **нельзя прочитать ни через API, ни через UI, ни агентом** —
GitHub отдаёт их только раннеру во время исполнения. Это не ограничение
инструмента, а механизм безопасности: утёкший доступ к репозиторию не означает
утёкший доступ к серверу.

### Для релиза Windows

| Секрет | Для чего |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Приватный ключ подписи обновлений. Без него сборка падает на шаге «Проверить ключи подписи» |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Пароль к нему |

Плюс `SERVER_HOST` / `SERVER_USER` / `SSH_PRIVATE_KEY` — те же, что у деплоя.

### Для релиза Android

| Секрет | Для чего |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Keystore подписи APK в base64. Нет — собирается debug-APK, который релизом не является |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | Там же |

### По мере готовности функций

| Секрет | Для чего | Когда |
| --- | --- | --- |
| `YANDEX_CLIENT_ID` / `YANDEX_CLIENT_SECRET` | Яндекс ID (OAuth) — основной вход | Вместе с аккаунтами |

Секреты, которые живут **только на сервере**, в `/var/www/zapiski/deploy/.env`
(в git его нет): пароль БД и `AUTH_SECRET` — генерируются скриптом деплоя при
первом запуске; `YOOKASSA_*`, `GOOGLE_PLAY_*` — дописываются руками. Образец —
[`../../deploy/.env.example`](../../deploy/.env.example).

Один раз руками, вне автоматики (подробно — в
[`../../deploy/SETUP.md`](../../deploy/SETUP.md)): A-записи `zapiski` и `notes`
в DNS, три секрета доступа к серверу, deploy key для сервера, Redirect URI в
консоли Яндекс ID.

## Версионирование

Все пакеты сейчас на `0.1.0`. Версия продукта ведётся в
[`../product/changelog.md`](../product/changelog.md). Версия установщика Windows
берётся из `apps/desktop/src-tauri/tauri.conf.json` и **обязана совпадать с
тегом** — это проверяется шагом workflow.

Протокол облака версионирован отдельно префиксом `/api/v1`: замена реализации
сервера не потребует изменений в клиенте, пока держится контракт.
