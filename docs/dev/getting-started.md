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
pnpm build          # собрать пакеты и веб      ← сейчас падает, см. ниже
pnpm dev            # веб в режиме разработки   ← сейчас падает, см. ниже
```

По пакетам:

```bash
pnpm --filter @zapiski/core test
pnpm --filter @zapiski/core build          # tsc → dist/
pnpm --filter @zapiski/editor test
pnpm --filter @zapiski/ui test
pnpm --filter @zapiski/ui gallery          # витрина компонентов в браузере
pnpm --filter @zapiski/server test
```

### Что реально можно запустить и посмотреть глазами

**Витрина компонентов** — единственная работающая визуальная поверхность:

```bash
pnpm --filter @zapiski/ui gallery
```

Vite поднимет `packages/ui/gallery.html`, откроется страница со всеми
компонентами библиотеки, переключателями трёх тем и шести акцентов. Это тот
самый артефакт, по которому проверяется пункт B1 приёмочного листа.

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

### `pnpm dev` и `pnpm build` падают

```
No projects matched the filters in "/home/user/zapiski"
```

Оба скрипта в корневом `package.json` ссылаются на пакет `@zapiski/web`
(`apps/web`), которого в репозитории **ещё нет**. Это не поломка окружения:
оболочки в текущей сборке не созданы. Пока их нет, собирайте пакеты по
отдельности:

```bash
pnpm -r --filter "./packages/**" build
```

### `pnpm lint:tokens` падает

На момент написания линтер находит 11 цветовых литералов в
`packages/core/src/export/html.ts` — это CSS печатного документа для экспорта в
HTML/PDF. Автор файла считает их намеренными (экспортный документ покидает
приложение и не может зависеть от рантайм-токенов), но правило репозитория
исключений не знает, и шаг «Линт токенов» в CI на этом красный.
Решение за владельцами `packages/core` и `packages/ui`: либо добавить файл в
список исключений линтера, либо вынести палитру печати в токены.

### Тесты сервера «пропущены»

Если в системе нет `initdb`/`pg_ctl`, `server/test/globalSetup.ts` печатает
предупреждение и продолжает: тесты, которым нужна база, помечаются
пропущенными. Чтобы прогнать всё:

```bash
TEST_DATABASE_URL='postgresql://user:pass@localhost:5432/zapiski_test' \
  pnpm --filter @zapiski/server test
```

### `packages/ui` не собирается в `dist/`

Так задумано: `@zapiski/ui` отдаётся исходниками (`main: ./src/index.ts`),
потому что его CSS должен пройти через сборщик приложения. Скрипт `build` там —
это `tsc --noEmit`, то есть проверка типов, а не компиляция.

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
* Правила совместной работы — [contributing.md](contributing.md).
