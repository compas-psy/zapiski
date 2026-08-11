# Шрифты — self-hosted, без CDN

`tz/ZAPISKI_TZ_2_Engineering.md` §10 и local-first принцип продукта: все
гарнитуры поставляются в сборке (`.woff2`), **в рантайме нет ни одного
обращения к CDN**. Файлы в этом каталоге — часть репозитория, а не результат
загрузки при запуске. В Tauri-сборке внешний CDN вообще недоступен, так что
это не про приватность, а про то, будет ли текст виден.

## Что лежит здесь

`tz/ZAPISKI_TZ_1_Design.md` §1, строка «Шрифты» — принято и не
пересматривается:

| Гарнитура | Роль | Пакет Fontsource | Начертания | Подмножества |
| --- | --- | --- | --- | --- |
| **Golos Text** | интерфейс и текст заметки | `@fontsource/golos-text` | 400, 500, 600, 700 | latin, latin-ext, cyrillic, cyrillic-ext |
| **Source Serif 4** | «бумажный» режим чтения заметки | `@fontsource/source-serif-4` | 400, 600 + курсивы | latin, latin-ext, cyrillic, cyrillic-ext |
| **JetBrains Mono** | код, raw-режим, даты и табличные числа | `@fontsource/jetbrains-mono` | 400, 500 | latin, latin-ext, cyrillic, cyrillic-ext |

Всего 40 файлов `.woff2`. Каждый `@font-face` в `../styles/fonts.css` объявлен
со своим `unicode-range`, поэтому браузер качает только реально нужные
подмножества: для русского интерфейса это `cyrillic` + `latin`.

**Кириллица здесь не довесок.** Golos Text нарисован с кириллицей как первым
письмом, JetBrains Mono держит её в моноширинном — это важно для raw-режима,
где моноширинным набран весь текст заметки, а не только вставки кода. Прежний
набор (Geist / Geist Mono), пришедший вместе с чужой дизайн-системой, убран
вместе с ней: у Geist кириллица есть только в публикации из Google Fonts, и
выбор не той публикации из двух одноимённых был отдельной ловушкой.

## Fallback-стек

Объявлен в `design/tokens.json`, группа `typography`:

```
Golos Text     → Segoe UI → Noto Sans → Helvetica Neue → Arial → sans-serif
Source Serif 4 → Noto Serif → Georgia → Times New Roman → serif
JetBrains Mono → Cascadia Mono → Roboto Mono → Noto Sans Mono → ui-monospace
```

Segoe UI и Roboto покрывают кириллицу на Windows и Android, поэтому текст
остаётся читаемым, даже если `.woff2` почему-то не загрузился.
`font-display: swap` — текст виден сразу, без «невидимой» фазы.

Курсива у Golos Text в нашем наборе нет — в вебе он синтезируется браузером.
Для настоящего курсива в тексте заметки предусмотрен serif-режим.

## Лицензии

Все три — **SIL Open Font License 1.1**, свободны для встраивания и
коммерческого использования. Тексты лицензий лежат рядом:

- `LICENSE-golos-text.txt`
- `LICENSE-jetbrains-mono.txt`
- `LICENSE-source-serif-4.txt`

## Откуда взялись и как обновить

Файлы вендорятся из пакетов [Fontsource](https://fontsource.org), которые
публикуют ровно те же `.woff2`, что и Google Fonts, но без обращения к их
серверам.

```bash
pnpm --filter @zapiski/ui up "@fontsource/*"
pnpm --filter @zapiski/ui fonts:sync   # копирует .woff2 и пересобирает styles/fonts.css
```

`scripts/sync-fonts.mjs` — единственный источник `../styles/fonts.css`;
править этот CSS руками нельзя, он перезаписывается.

Если когда-нибудь понадобится взять файлы напрямую (без npm), точные URL:

```
https://cdn.jsdelivr.net/npm/@fontsource/golos-text@5/files/golos-text-<subset>-<weight>-normal.woff2
https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5/files/jetbrains-mono-<subset>-<weight>-normal.woff2
https://cdn.jsdelivr.net/npm/@fontsource/source-serif-4@5/files/source-serif-4-<subset>-<weight>-<style>.woff2
```

где `<subset>` ∈ `latin | latin-ext | cyrillic | cyrillic-ext`,
`<weight>` ∈ `400 | 500 | 600 | 700`, `<style>` ∈ `normal | italic`.
Эти адреса нужны только для ручного обновления — приложение к ним не ходит.

## Почему `sideEffects` в package.json перечисляет `./src/index.ts`

Стили пакета подключаются побочным импортом в `src/index.ts`. Пока там стояло
только `"*.css"`, сборщик оболочки считал сам barrel-модуль
side-effect-free, вычищал его целиком — и весь слой `styles/index.css` (токены,
шрифты, база, типографика) **не попадал в бандл `apps/web`**, хотя CSS
компонентов доезжал. Отсюда `"./src/index.ts"` в списке: это не косметика.
