# Начало работы

Всё, что нужно, чтобы собрать репозиторий и прогнать тесты.

## Требования

| Инструмент | Версия | Проверить |
| --- | --- | --- |
| Node.js | ≥ 20 (CI и продакшен — 22) | `node -v` |
| pnpm | 10.33.0 (закреплён в `packageManager`) | `pnpm -v` |
| PostgreSQL | 14–16, **только для тестов сервера** | `pg_ctl --version` |
| Docker | только для развёртывания и проверки compose | `docker --version` |

pnpm ставится через corepack:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

Postgres для тестов сервера не обязателен: без него тесты, которым нужна база,
помечаются пропущенными, а остальные идут как есть — см.
[testing.md](testing.md#тесты-сервера-и-postgres).

## Установка

```bash
git clone <репозиторий> zapiski
cd zapiski
pnpm install
```

`pnpm install` ставит зависимости всех пакетов воркспейса
(`packages/*`, `apps/*`, `server`). У `server` **отдельный `package-lock.json`
и отдельный npm** — так собирается его Docker-образ; в воркспейс pnpm он всё
равно входит, поэтому `pnpm -r test` захватывает и его.

## Команды

Из корня репозитория:

```bash
pnpm test           # тесты всех пакетов (vitest)
pnpm typecheck      # проверка типов всех пакетов
pnpm lint:tokens    # падает при hex-цвете вне токен-файла
pnpm build          # собрать пакеты и веб
pnpm dev            # веб в режиме разработки, http://localhost:5173
```

По пакетам:

```bash
pnpm --filter @zapiski/core test
pnpm --filter @zapiski/core build          # tsc → dist/
pnpm --filter @zapiski/editor test
pnpm --filter @zapiski/ui test
pnpm --filter @zapiski/ui gallery          # витрина компонентов в браузере
pnpm --filter @zapiski/app test
pnpm --filter @zapiski/server test
```

### Что реально можно запустить и посмотреть глазами

**Само приложение в браузере** — быстрее всего:

```bash
pnpm dev
```

Поднимется `apps/web` (Vite, порт по умолчанию 5173). Пакеты воркспейса
резолвятся в исходники, поэтому пересборка `packages/*` не нужна: правка экрана
видна сразу. Если сервер не поднят, приложение всё равно работает: облако
необязательно (инвариант local-first).

> Дев-прокси `/api` в `apps/web/vite.config.ts` смотрит на
> `http://127.0.0.1:8787`, а сервер по умолчанию слушает **3100**
> (`server/src/config/env.ts`). Поднимая сервер локально, задайте `PORT=8787`
> либо поправьте прокси — иначе запросы к облаку в деве будут падать.

Место хранения выбирается на втором шаге онбординга: в Chromium откроется
системный диалог выбора папки (File System Access API), в остальных браузерах
vault ляжет в OPFS. Подробности — [modules/platforms.md](modules/platforms.md#веб-appsweb).

**Приложение на Windows** (нужен Windows и Rust-тулчейн):

```bash
pnpm --filter @zapiski/desktop tauri dev
```

Локально в этом окружении не проверяется — Windows-тулчейна нет, это
зафиксировано в [`../ACCEPTANCE.md`](../ACCEPTANCE.md). Единственное место,
где собирается `.msi`/`.exe`, — workflow `build-windows.yml`.

**Android** пока запустить нечем: у `apps/mobile` нет `package.json` и не
сгенерирован gradle-проект — см.
[modules/platforms.md](modules/platforms.md#android-что-осталось).

**Витрина компонентов** — быстрый способ увидеть токены и всю библиотеку:

```bash
pnpm --filter @zapiski/ui gallery
```

Vite поднимет `packages/ui/gallery.html`, откроется страница со всеми
компонентами библиотеки, переключателями трёх тем и шести акцентов. Это тот
самый артефакт, по которому проверяется пункт B1 приёмочного листа.

**Отладочное меню** — воспроизведение любой ячейки матрицы `BEHAVIOR.md` §12
(пустое, загрузка, оффлайн, ошибка, заперто): в приложении «Настройки → Внешний
вид → Отладочное меню». Приёмочный критерий №10.

**Сервер KompasCloud** локально:

```bash
cd server
export DATABASE_URL='postgresql://localhost:5432/zapiski'
export AUTH_SECRET='строка-минимум-32-символа-длиной-иначе-не-стартует'
npm run migrate     # накатить миграции
npm run dev         # node --watch, слушает 3100
curl localhost:3100/health
```

Полный список переменных окружения — в
[modules/server.md](modules/server.md#конфигурация).

## Известные грабли

### `pnpm-lock.yaml` не знает про `apps/mobile`

На момент сверки в lock-файле нет записи для `apps/mobile`, хотя
`package.json` там появился. Следствия:

* `pnpm --filter @zapiski/mobile typecheck` падает с
  `Cannot find type definition file for 'vite/client'` — зависимости оболочки
  просто не установлены;
* `pnpm install --frozen-lockfile`, которым начинается **каждый** workflow,
  откажется ставить: lock не соответствует воркспейсу.

Лечится одним `pnpm install` с последующим коммитом обновлённого
`pnpm-lock.yaml`.

### Перф-тесты падают при полном прогоне

`pnpm -r test` запускает пакеты параллельно, и на загруженной машине
перф-бюджеты ядра (FTS <50 мс, открытие заметки <150 мс) в них не укладываются:
измеряется не код, а конкуренция за процессор.

Проверять перф нужно изолированно:

```bash
pnpm --filter @zapiski/core exec vitest run test/perf.test.ts
```

Порядок величин на спокойной машине: FTS по слову — единицы миллисекунд,
по фразе — около 20 мс, открытие заметки 1 МБ — около 40 мс. Если изолированный
прогон красный — это уже регрессия.

### Тесты сервера «пропущены»

Если в системе нет `initdb`/`pg_ctl`, `server/test/globalSetup.ts` печатает
предупреждение и продолжает: тесты, которым нужна база, помечаются
пропущенными. Чтобы прогнать всё:

```bash
TEST_DATABASE_URL='postgresql://user:pass@localhost:5432/zapiski_test' \
  pnpm --filter @zapiski/server test
```

### `packages/ui` и `packages/app` не собираются в `dist/`

Так задумано: оба отдаются исходниками (`main: ./src/index.ts`), потому что их
CSS должен пройти через сборщик приложения. Скрипт `build` там — это
`tsc --noEmit`, то есть проверка типов, а не компиляция. Собираемые в `dist`
пакеты — только `@zapiski/core` и `@zapiski/editor`.

### Предупреждение Vite «chunks are larger than 500 kB»

Сборка веба печатает его на главный бандл (~648 КБ, ~205 КБ в gzip). Это
ожидаемо: туда попадают CodeMirror и всё приложение целиком. Подсветка языков
кода уже вынесена в динамические чанки. Бюджета на размер веб-бандла в ТЗ нет —
бюджеты §6 заданы для установщика Windows (<25 МБ) и APK (<30 МБ).

### Шрифты

`.woff2` лежат в `packages/ui/src/fonts/` и попадают в git. Обновляются
скриптом `pnpm --filter @zapiski/ui fonts:sync`, который тянет их из
`@fontsource/*`. В рантайме к CDN обращений нет — требование
`DESIGN_TOKENS.md` §2.

### Node 22 и `--experimental-strip-types`

`server` исполняет TypeScript напрямую (`npm run dev`, `npm run migrate`) через
`--experimental-strip-types`. На Node 20 это не заработает — для сервера нужен
Node 22.

## Что дальше

* Как устроено ядро — [modules/core.md](modules/core.md).
* Как устроен редактор — [modules/editor.md](modules/editor.md).
* Как устроены экраны — [modules/app.md](modules/app.md).
* Чем различаются три оболочки — [modules/platforms.md](modules/platforms.md).
* Правила совместной работы — [contributing.md](contributing.md).
