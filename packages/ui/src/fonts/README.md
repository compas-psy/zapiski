# Шрифты — self-hosted, без CDN

`DESIGN_TOKENS.md` §2: все три гарнитуры поставляются в сборке (`.woff2`),
**в рантайме нет ни одного обращения к CDN**. Файлы в этом каталоге — часть
репозитория, а не результат загрузки при запуске.

## Что лежит здесь

| Гарнитура | Роль | Версия (Google Fonts) | Начертания | Подмножества |
| --- | --- | --- | --- | --- |
| **Golos Text** | основной интерфейс и текст заметки | v7 | 400, 500, 600, 700 | latin, latin-ext, cyrillic, cyrillic-ext |
| **Source Serif 4** | serif-режим редактора, публичная страница | v14 | 400, 600 + курсивы | latin, latin-ext, cyrillic, cyrillic-ext |
| **JetBrains Mono** | даты, счётчики, код, raw | v24 | 400, 500 | latin, latin-ext, cyrillic, cyrillic-ext |

Всего 40 файлов `.woff2`, 532 КБ. Каждый `@font-face` в
`../styles/fonts.css` объявлен со своим `unicode-range`, поэтому браузер
качает только реально нужные подмножества: для русского интерфейса это
`cyrillic` + `latin` (~50 КБ на гарнитуру).

Курсива у Golos Text не существует — в вебе он синтезируется браузером.
Для настоящего курсива в тексте заметки предусмотрен serif-режим.

## Лицензии

Все три — **SIL Open Font License 1.1**, свободны для встраивания и
коммерческого использования. Тексты лицензий лежат рядом:

- `LICENSE-golos-text.txt`
- `LICENSE-source-serif-4.txt`
- `LICENSE-jetbrains-mono.txt`

Источник: <https://github.com/google/fonts>.

## Откуда взялись и как обновить

Файлы вендорятся из пакетов [Fontsource](https://fontsource.org) (5.3.0),
которые публикуют ровно те же `.woff2`, что и Google Fonts, но без обращения
к их серверам:

- `@fontsource/golos-text` → <https://www.npmjs.com/package/@fontsource/golos-text>
- `@fontsource/source-serif-4` → <https://www.npmjs.com/package/@fontsource/source-serif-4>
- `@fontsource/jetbrains-mono` → <https://www.npmjs.com/package/@fontsource/jetbrains-mono>

Обновление:

```bash
pnpm --filter @zapiski/ui up "@fontsource/*"
pnpm --filter @zapiski/ui fonts:sync   # копирует .woff2 и пересобирает styles/fonts.css
```

`scripts/sync-fonts.mjs` — единственный источник `../styles/fonts.css`;
править этот CSS руками нельзя, он перезаписывается.

Если когда-нибудь понадобится взять файлы напрямую (без npm), точные URL:

```
https://cdn.jsdelivr.net/npm/@fontsource/golos-text@5.3.0/files/golos-text-<subset>-<weight>-normal.woff2
https://cdn.jsdelivr.net/npm/@fontsource/source-serif-4@5.3.0/files/source-serif-4-<subset>-<weight>-<style>.woff2
https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.3.0/files/jetbrains-mono-<subset>-<weight>-normal.woff2
```

где `<subset>` ∈ `latin | latin-ext | cyrillic | cyrillic-ext`,
`<weight>` ∈ `400 | 500 | 600 | 700`, `<style>` ∈ `normal | italic`.
Эти адреса нужны только для ручного обновления — приложение к ним не ходит.

## Fallback-стек

Если `.woff2` почему-то не загрузился, текст остаётся читаемым и кириллическим
(`--font-sans`, `--font-serif`, `--font-mono` в `../styles/tokens.css`):

```
Golos Text   → Segoe UI → Noto Sans → Helvetica Neue → Arial → sans-serif
Source Serif → Noto Serif → Georgia → Times New Roman → serif
JetBrains    → Cascadia Mono → Roboto Mono → Noto Sans Mono → ui-monospace → monospace
```

Все запасные варианты покрывают кириллицу на Windows, Android и Linux.
`font-display: swap` — текст виден сразу, без «невидимой» фазы.
