# Шрифты — self-hosted, без CDN

`DESIGN_TOKENS.md` §2: все гарнитуры поставляются в сборке (`.woff2`),
**в рантайме нет ни одного обращения к CDN**. Файлы в этом каталоге — часть
репозитория, а не результат загрузки при запуске.

`DS-ALIGNMENT.md` §6 сменил семейства: Golos Text → **Geist**,
JetBrains Mono → **Geist Mono**. Шкала размеров и весов из `DESIGN_TOKENS.md`
§2 сохранена без изменений — поменялось только семейство.

## Почему файлы вообще здесь, а не берутся из системы

Снимок дизайн-системы подключает Geist так:

```css
/* src/styles/simpas/vendor/tokens/fonts.css — НЕ ПРАВИТЬ */
@import url("https://fonts.googleapis.com/css2?family=Geist:…&display=swap");
```

Каталог `vendor/` — побайтовая копия системы, и правки в нём запрещены.
Перекрыть `@import url(…)` каскадом нельзя: это директива загрузки, а не
объявление — запрос к fonts.googleapis.com ушёл бы в любом случае. Поэтому наш
`src/styles/simpas-offline.css` повторяет список импортов системы **без**
`tokens/fonts.css`, а на его место ставит `../styles/fonts.css` из этого
каталога. Сторож — `test/simpas.test.ts`.

## Что лежит здесь

| Гарнитура | Роль | Пакет Fontsource | Начертания | Подмножества |
| --- | --- | --- | --- | --- |
| **Geist** | интерфейс и текст заметки | `@fontsource/geist` | 400, 500, 600, 700 | latin, latin-ext, cyrillic, cyrillic-ext |
| **Source Serif 4** | режим чтения заметки, публичная страница | `@fontsource/source-serif-4` | 400, 600 + курсивы | latin, latin-ext, cyrillic, cyrillic-ext |
| **Geist Mono** | даты, времена, табличные числа, код, raw | `@fontsource/geist-mono` | 400, 500 | latin, latin-ext, cyrillic, cyrillic-ext |

Всего 40 файлов `.woff2`. Каждый `@font-face` в `../styles/fonts.css` объявлен
со своим `unicode-range`, поэтому браузер качает только реально нужные
подмножества: для русского интерфейса это `cyrillic` + `latin`.

### Важно про имя пакета Geist

У Vercel **две** публикации, и они не взаимозаменяемы:

- `@fontsource/geist-sans` — старый снимок из репозитория Vercel (v1.0.1,
  2023). Подмножество ровно одно, `latin`, **кириллицы в файле нет**. Для
  русского интерфейса непригоден;
- `@fontsource/geist` — публикация из Google Fonts (v5). Есть `cyrillic` и
  `cyrillic-ext`. Берём её.

Семейство в Google Fonts называется просто `Geist` (не «Geist Sans»), поэтому
`@font-face` объявлен как `'Geist'`. В `--font-sans` дизайн-системы первым
стоит `"Geist"`, так что имена совпадают; `Geist Sans` можно оставить в
fallback-стеке на случай системной установки под этим именем.

Курсива у Geist в нашем наборе нет — в вебе он синтезируется браузером. Для
настоящего курсива в тексте заметки предусмотрен serif-режим.

## Лицензии

Все три — **SIL Open Font License 1.1**, свободны для встраивания и
коммерческого использования. Тексты лицензий лежат рядом:

- `LICENSE-geist.txt`
- `LICENSE-geist-mono.txt`
- `LICENSE-source-serif-4.txt`

Источник: <https://github.com/google/fonts>.

## Откуда взялись и как обновить

Файлы вендорятся из пакетов [Fontsource](https://fontsource.org) (5.3.0),
которые публикуют ровно те же `.woff2`, что и Google Fonts, но без обращения
к их серверам.

```bash
pnpm --filter @zapiski/ui up "@fontsource/*"
pnpm --filter @zapiski/ui fonts:sync   # копирует .woff2 и пересобирает styles/fonts.css
```

`scripts/sync-fonts.mjs` — единственный источник `../styles/fonts.css`;
править этот CSS руками нельзя, он перезаписывается.

Если когда-нибудь понадобится взять файлы напрямую (без npm), точные URL:

```
https://cdn.jsdelivr.net/npm/@fontsource/geist@5.3.0/files/geist-<subset>-<weight>-normal.woff2
https://cdn.jsdelivr.net/npm/@fontsource/geist-mono@5.3.0/files/geist-mono-<subset>-<weight>-normal.woff2
https://cdn.jsdelivr.net/npm/@fontsource/source-serif-4@5.3.0/files/source-serif-4-<subset>-<weight>-<style>.woff2
```

где `<subset>` ∈ `latin | latin-ext | cyrillic | cyrillic-ext`,
`<weight>` ∈ `400 | 500 | 600 | 700`, `<style>` ∈ `normal | italic`.
Эти адреса нужны только для ручного обновления — приложение к ним не ходит.

## Fallback-стек

`--font-sans` и `--font-mono` объявляет сама дизайн-система
(`simpas/vendor/tokens/typography.css`), мы их не переопределяем:

```
Geist       → -apple-system → BlinkMacSystemFont → Segoe UI → Roboto → Helvetica Neue → Arial → sans-serif
Geist Mono  → ui-monospace → SFMono-Regular → Menlo → monospace
```

`--font-serif` — наш, продуктовое расширение поверх системы:

```
Source Serif 4 → Noto Serif → Georgia → Times New Roman → serif
```

Segoe UI и Roboto покрывают кириллицу на Windows и Android, поэтому текст
остаётся читаемым, даже если `.woff2` почему-то не загрузился.
`font-display: swap` — текст виден сразу, без «невидимой» фазы.

## Почему `sideEffects` в package.json перечисляет `./src/index.ts`

Стили пакета подключаются побочным импортом в `src/index.ts`. Пока там стояло
только `"*.css"`, сборщик оболочки считал сам barrel-модуль
side-effect-free, вычищал его целиком — и весь слой `styles/index.css` (токены,
шрифты, база, типографика) **не попадал в бандл `apps/web`**, хотя CSS
компонентов доезжал. Отсюда `"./src/index.ts"` в списке: это не косметика.
