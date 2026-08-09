# Разработка КОМПАС.ЗАПИСКИ

Точка входа для разработчика. Здесь — как поднять окружение, как устроено
монорепо, куда что класть и по каким правилам мы работаем.

> **Статус сборки 0.1.0.** Готовы четыре слоя: ядро (`packages/core`),
> редактор (`packages/editor`), дизайн-система (`packages/ui`) и облачный
> бэкенд (`server`). **Слоя экранов (`packages/app`) и платформенных оболочек
> (`apps/web`, `apps/desktop`, `apps/mobile`) в репозитории ещё нет** — в
> `packages/app` лежит только контракт типов, каталог `apps/` пуст. Из-за
> этого `pnpm dev` и `pnpm build` в корне сейчас падают: см.
> [getting-started.md](getting-started.md#известные-грабли).

## Документы

| Документ | О чём |
| --- | --- |
| [getting-started.md](getting-started.md) | Установка, запуск, тесты, типичные грабли |
| [modules/core.md](modules/core.md) | Ядро: vault, markdown, индекс, крипто, CRDT, синк, импорт/экспорт |
| [modules/ui.md](modules/ui.md) | Токен-слой (3 темы × 6 акцентов) и библиотека компонентов |
| [modules/editor.md](modules/editor.md) | Live-preview, IME, хоткеи, как добавить markdown-элемент |
| [modules/server.md](modules/server.md) | API KompasCloud, схема БД, модель zero-knowledge |
| [testing.md](testing.md) | Что покрыто тестами, «злой синк», перф-бюджеты |
| [build-and-release.md](build-and-release.md) | Сборка веба/Windows/Android, workflow'ы, автообновление, секреты |
| [contributing.md](contributing.md) | Соглашения: язык комментариев, приоритет ТЗ, ADR, запрет глубоких импортов |

## Документы, которыми владеет не эта команда

Их читают и на них ссылаются, но **не редактируют**:

* [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — инженерный контракт: порты
  платформ, инварианты, перф-бюджеты. Владелец — CTO.
* [`../ACCEPTANCE.md`](../ACCEPTANCE.md) — приёмочный лист. Владелец — CPO.
* [`../adr/`](../adr/) — архитектурные решения и обоснование каждого отклонения
  от рекомендованного в ТЗ стека. **Новое отклонение — новый ADR**, правила в
  [contributing.md](contributing.md#adr).
* [`../spec/`](../spec/) — исходное ТЗ. Приоритет при конфликте:
  `BEHAVIOR.md` > `SCREENS.md` > `DESIGN_TOKENS.md` > `README.md` (ТЗ) >
  `ARCHITECTURE.md`.

Действующие ADR:

* [ADR-0001](../adr/0001-yadro-na-typescript-vmesto-rust.md) — ядро на
  TypeScript вместо Rust;
* [ADR-0002](../adr/0002-indeks-i-fts-bez-sqlite.md) — собственный
  инвертированный индекс вместо SQLite + FTS5;
* [ADR-0003](../adr/0003-backend-na-node-i-izolyaciya-na-cmpas-ru.md) —
  бэкенд на Node/Fastify и правила изоляции на сервере cmpas.ru.

## Структура монорепо

```
packages/core     логика: vault, markdown, индекс+FTS, крипто, CRDT,
                  синк, импорт/экспорт, i18n. Платформо-независима
packages/ui       токены тем и библиотека React-компонентов
packages/editor   CodeMirror 6 live-preview + React-обёртка
packages/app      ВСЕ экраны и всё поведение     ← пока только contract.ts
apps/web          оболочка PWA                   ← пока не создана
apps/desktop      оболочка Tauri 2 (Windows)     ← пока не создана
apps/mobile       оболочка Tauri 2 (Android)     ← пока не создана
server            KompasCloud API (Node 22 + Fastify + PostgreSQL)
deploy            nginx, Docker Compose, скрипты развёртывания
scripts           lint-tokens.mjs — «ни одного hex вне токенов»
docs              документация (этот каталог) и ТЗ
```

Пакеты воркспейса объявлены в `pnpm-workspace.yaml`: `packages/*`, `apps/*`,
`server`. `packages/app` **не является пакетом воркспейса**, пока у него нет
`package.json`.

## Куда что класть

| Что | Куда | Почему |
| --- | --- | --- |
| Разбор markdown, работа с файлами, поиск, крипто, синк | `packages/core` | Один и тот же байт-в-байт код на всех целях (ADR-0001) |
| Цвет, размер, отступ, новый визуальный компонент | `packages/ui` | Единственное место, где живут значения дизайна |
| Всё, что происходит внутри текстового поля заметки | `packages/editor` | Редактор ничего не знает про экраны и хранилище |
| Экран, роутинг, состояние приложения, палитра команд | `packages/app` | Единственное место с UI-логикой продукта |
| Точка входа, реализация платформенных портов, манифест | `apps/<цель>` | И **ничего** больше — правило `ARCHITECTURE.md` §1 |
| Эндпоинт, миграция, работа с БД и блобами | `server` | Zero-knowledge: только шифротекст и метаданные |

Направление зависимостей — строго вниз:

```
apps/*  →  packages/app  →  packages/{ui, editor, core}
                                editor ─╳→ core   (редактор в ядро не ходит)
server  →  (собственные типы протокола, см. modules/server.md)
```

`packages/editor` **не импортирует** `@zapiski/core`: всё, что ему нужно от
приложения, приходит через объект `EditorRuntime`
([modules/editor.md](modules/editor.md#editorruntime--мост-с-приложением)).

## Ключевые соглашения в одну строку каждое

* Публичный API пакета — только `src/index.ts`, глубокие импорты запрещены.
* Комментарии и сообщения об ошибках — по-русски.
* Ни одного hex вне `packages/ui/src/styles/tokens.css` (проверяет `pnpm lint:tokens`).
* Ни одной строки интерфейса, зашитой в компонент, — только каталоги i18n.
* Тексты ошибок — дословно из реестра `BEHAVIOR.md` §11.
* Слова «Сохранить» в интерфейсе нет; автосохранение — debounce 500 мс + blur.
* Новый компонент сначала описывается в `docs/spec/COMPONENTS.md`.

Подробно и с обоснованиями — в [contributing.md](contributing.md).
