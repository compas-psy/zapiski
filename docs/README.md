# Документация КОМПАС.ЗАПИСКИ

Три контура документации плюс инженерные и приёмочные документы.

| Контур | Для кого | Точка входа |
| --- | --- | --- |
| **[Разработка](dev/README.md)** | Тем, кто пишет код | [dev/README.md](dev/README.md) |
| **[Продукт](product/README.md)** | Продукту, дизайну, маркетингу, поддержке | [product/README.md](product/README.md) |
| **[Справка](user/README.md)** | Пользователю | [user/README.md](user/README.md) |

> **Состояние 0.1.0.** Готовы ядро (`packages/core`), редактор
> (`packages/editor`), дизайн-система (`packages/ui`) и облачный бэкенд
> (`server`). **Слоя экранов (`packages/app`) и платформенных оболочек
> (`apps/*`) ещё нет** — приложение как таковое собрать нельзя. Вся
> документация ниже помечает значком ⏳ то, что описано в спецификации, но в
> текущей сборке недоступно. Полная сверка — [product/scope.md](product/scope.md).

---

## Разработка — `dev/`

| Документ | О чём |
| --- | --- |
| [dev/README.md](dev/README.md) | Структура монорепо, куда что класть, соглашения кратко |
| [dev/getting-started.md](dev/getting-started.md) | Установка, запуск, тесты, известные грабли |
| [dev/modules/core.md](dev/modules/core.md) | Ядро: порт `VaultStorage`, модель заметки, контейнер шифрования, индекс и операторы поиска, синк и разрешение конфликтов |
| [dev/modules/ui.md](dev/modules/ui.md) | Токен-слой (3 темы × 6 акцентов), правило «ни одного hex вне токенов», компоненты и их пропсы |
| [dev/modules/editor.md](dev/modules/editor.md) | Live-preview, решение «opacity вместо replace», защита IME, как добавить markdown-элемент, хоткеи |
| [dev/modules/server.md](dev/modules/server.md) | API KompasCloud поэндпоинтно, схема БД, zero-knowledge, что сервер принципиально не может |
| [dev/testing.md](dev/testing.md) | Состав тестов, «злой синк», перф-бюджеты, что проверить нельзя |
| [dev/build-and-release.md](dev/build-and-release.md) | Сборка веба/Windows/Android, workflow'ы, автообновление, секреты |
| [dev/contributing.md](dev/contributing.md) | Язык комментариев, приоритет ТЗ, правило ADR, границы пакетов, инварианты |

## Продукт — `product/`

| Документ | О чём |
| --- | --- |
| [product/README.md](product/README.md) | Навигация и текущее положение дел |
| [product/concept.md](product/concept.md) | Продукт в одном абзаце, аудитория, сравнение с Bear / Obsidian / Notion / Simplenote |
| [product/principles.md](product/principles.md) | Шесть принципов и красные линии — и почему их нельзя нарушать |
| [product/scope.md](product/scope.md) | P0 / P1 / P2 / анти-скоуп с отметкой фактического состояния кода |
| [product/platforms.md](product/platforms.md) | Платформы, приоритеты, таблица возможностей |
| [product/monetization.md](product/monetization.md) | Тарифы, правила paywall, бандл с Дневником |
| [product/metrics.md](product/metrics.md) | NSM, активация, retention, конверсия |
| [product/roadmap.md](product/roadmap.md) | Этапы 0–6 со статусом каждого |
| [product/changelog.md](product/changelog.md) | Что вошло в версию 0.1.0 и её известные ограничения |

## Справка — `user/`

Русский язык, обращение на «вы», спокойный тон.

| Документ | О чём |
| --- | --- |
| [user/README.md](user/README.md) | Оглавление справки |
| [user/quick-start.md](user/quick-start.md) | Первые пять минут |
| [user/editor.md](user/editor.md) | Как писать: разметка человеческим языком |
| [user/organize.md](user/organize.md) | Папки, теги, закрепление, архив, корзина, жесты |
| [user/search.md](user/search.md) | Поиск и все условия с примерами |
| [user/sync.md](user/sync.md) | Три способа хранения, что происходит при конфликте |
| [user/encryption.md](user/encryption.md) | Шифрование, пароль, отпечаток, что видно на диске |
| [user/import-export.md](user/import-export.md) | Переезд из Obsidian, Bear, Notion, Evernote; экспорт |
| [user/shortcuts.md](user/shortcuts.md) | Горячие клавиши и жесты |
| [user/faq.md](user/faq.md) | Честные ответы на частые вопросы |
| [user/troubleshooting.md](user/troubleshooting.md) | Разбор каждого сообщения приложения |

---

## Инженерные и приёмочные документы

Владельцы — CTO и заказчик. Читаются и цитируются, **не редактируются** этой
командой.

| Документ | О чём | Владелец |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Инженерный контракт: как достигается сквозной функционал, платформенные порты, десять инвариантов, перф-бюджеты, правила совместной работы | CTO |
| [ACCEPTANCE.md](ACCEPTANCE.md) | Приёмочный лист: инженерия, дизайн, поведение, сквозной функционал, облако, красные линии; и что заведомо невозможно проверить в текущей среде | CPO |
| [adr/](adr/) | Архитектурные решения — обоснование каждого отклонения от рекомендованного стека | CTO |

Действующие ADR:

* [ADR-0001](adr/0001-yadro-na-typescript-vmesto-rust.md) — ядро на TypeScript
  вместо Rust: один и тот же код на вебе, Windows и Android;
* [ADR-0002](adr/0002-indeks-i-fts-bez-sqlite.md) — собственный инвертированный
  индекс вместо SQLite + FTS5;
* [ADR-0003](adr/0003-backend-na-node-i-izolyaciya-na-cmpas-ru.md) — бэкенд на
  Node/Fastify и правила изоляции на действующем сервере cmpas.ru.

## Техническое задание — `spec/`

Исходные документы заказчика. **Приоритет при конфликте:**
`BEHAVIOR.md` > `SCREENS.md` > `DESIGN_TOKENS.md` > `README.md` (ТЗ) >
`ARCHITECTURE.md`. Если поведение не описано нигде — реализующий обязан
спросить, а не решить самостоятельно.

| Документ | О чём |
| --- | --- |
| [spec/README.md](spec/README.md) | Полное ТЗ: продукт, архитектура, данные, синк, функции, этапы, Definition of Done |
| [spec/BEHAVIOR.md](spec/BEHAVIOR.md) | Поведение каждого элемента, крайние случаи, хоткеи и жесты, **реестр текстов ошибок §11**, матрица состояний |
| [spec/SCREENS.md](spec/SCREENS.md) | Поэкранная спецификация: layout, размеры, копирайт, состояния |
| [spec/DESIGN_TOKENS.md](spec/DESIGN_TOKENS.md) | Единственный источник цвета, типографики и метрик |
| [spec/COMPONENTS.md](spec/COMPONENTS.md) | Библиотека компонентов и все их состояния |
| [spec/VOICE.md](spec/VOICE.md) | Голос → Markdown (P1): конвейер, стили, приватность, этапы |
| [spec/AGENT_BRIEF.md](spec/AGENT_BRIEF.md) | Стартовые промпты и правила работы агента |
| [spec/source_tz/ZAPISKI_Concept.md](spec/source_tz/ZAPISKI_Concept.md) | Исходная продуктовая концепция |
| [spec/source_tz/TZ_Claude_Code_v1.md](spec/source_tz/TZ_Claude_Code_v1.md) | Исходное ТЗ разработки, версия 1.0 |
| [spec/source_tz/TZ_Claude_Design.md](spec/source_tz/TZ_Claude_Design.md) | Исходный дизайн-бриф |

## Развёртывание

* [`../deploy/SETUP.md`](../deploy/SETUP.md) — что делается руками один раз:
  DNS, секреты, deploy key; порядок запуска workflow'ов; откат; частые случаи.
* [`../README.md`](../README.md) — корневой README репозитория.
