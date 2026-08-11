# @zapiski/ui

Токен-слой (3 темы × 3 акцента) и библиотека компонентов ЗАПИСОК.
React 19, TypeScript, обычный CSS с переменными — **без CSS-in-JS**: смена
темы и акцента происходит в рантайме без единого ререндера React.

Значения токенов приходят из **`design/tokens.json`** — единственного артефакта
передачи «дизайн → код» (`tz/ZAPISKI_TZ_3_Agents.md` §6). Из него генерируется
`src/styles/tokens.generated.css`; править CSS руками нельзя — `build-tokens.mjs
--check` в преflight падает. Рядом лежит `src/styles/tokens.css` с производными:
hover, кольца фокуса, множители редактора.

Источники истины по убыванию: `docs/spec/tz/*` → `BEHAVIOR.md` → `SCREENS.md` →
`DESIGN_TOKENS.md`. Состав библиотеки — `DS-MAPPING.md` рядом с этим файлом.

## Установка в оболочку

```tsx
import { ThemeProvider, ToastProvider, themeInitScript } from '@zapiski/ui';
// стили подключаются самим пакетом (src/index.ts импортирует styles/index.css)

createRoot(host).render(
  <ThemeProvider>
    <ToastProvider>
      <App />
    </ToastProvider>
  </ThemeProvider>,
);
```

В `index.html` оболочки — инлайном, **до** стилей и бандла:

```html
<script>/* сюда подставить строку themeInitScript */</script>
```

Он ставит `data-theme` / `data-accent` до первого кадра: при запуске нет ни
белой вспышки, ни подмены темы после старта.

## Тема

```tsx
const { preference, theme, accent, editor, setTheme, setAccent, setEditor } = useTheme();
```

- `preference` — что выбрал пользователь: `system | paper | graphite | ink`
  (по умолчанию `system`: светлая ОС → `paper`, тёмная → `graphite`;
  `ink` только вручную). Переживает перезапуск (localStorage).
- `theme` — что реально применено. `paper` — «Бумага», светлая и базовая;
  `graphite` — «Графит», обычная тёмная; `ink` — «Чернила», OLED.
- `accent` — `garnet | blueberry | slate` (Гранат, Черника, Грифель).
  По умолчанию `garnet`: он же цвет иконки (Р5). Выбор, сохранённый прежней
  версией, переносится картой отменённых имён — см. `src/theme/types.ts`.
- `editor` — размер (14/15/16/18/20), интерлиньяж (1.45/1.65/1.85), ширина
  колонки (640/720/`'full'`), `typeface` (`sans|serif`), `compact`.
  Всё это — **множители** над базовыми токенами, а не отдельные наборы:
  провайдер пишет `--editor-font-scale`, `--editor-line-scale`,
  `--editor-measure` на корень.

Смена темы или акцента включает кроссфейд 200 мс (кроме `prefers-reduced-motion`).

Акцент и тему можно переопределить **на поддереве** — так делаются кружки
выбора акцента и живое превью заметки в настройках:

```tsx
<div data-theme="graphite" data-accent="pine">…</div>
```

## Правила, которые нельзя нарушать

1. **Ни одного hex вне `src/styles/tokens.css`** (и снимка системы, который
   нам не принадлежит). Проверяет `node scripts/lint-tokens.mjs` (падает с
   кодом 1). Только `var(--*)`.
   1.1. В самом `tokens.css` литерал допустим лишь там, где системе нечего
   предложить: акценты из `DS-ALIGNMENT §3`, роли `*-text` из §4 и тёмные
   темы §5. Каждый помечен маркером `[§3]` / `[§4]` / `[§5]`.
2. **Ни одной строки текста внутри компонента.** Все подписи, включая
   `aria-label`, приходят пропсами: тексты живут в каталогах i18n.
3. Touch-target ≥ 44 px. Там, где элемент визуально меньше (компактная
   кнопка 36, тулбар 34, чип, FAB-подобные), зона нажатия расширена
   псевдоэлементом — не уменьшайте её.
4. Размеры текста — в `rem`. Масштаб шрифта ОС до 200% не должен ломать экран.
5. Запрещены пульсации, bounce/overshoot, параллакс, конфетти и красные
   бейджи-счётчики (`DESIGN_TOKENS.md` §3).

## Что есть

| Группа | Компоненты |
| --- | --- |
| Кнопки | `Button` (primary/secondary/outline/text/destructive), `IconButton`, `Fab` |
| Поля | `TextField`, `SearchField`, `CodeInput`, `PinDots` |
| Чипы | `Tag`, `FilterChip`, `Badge`, `ChipRow` |
| Переключатели | `Switch`, `Checkbox`, `Radio`, `RadioGroup`, `SegmentedControl` |
| Списки | `List`, `ListRow`, `SectionLabel` |
| Оверлеи | `BottomSheet`, `Modal`, `Drawer`, `Toast`/`ToastProvider`/`useToast`, `Tooltip` |
| Обратная связь | `InfoNote`, `Skeleton`, `SkeletonList`, `Progress`, `Spinner`, `EmptyState`, `SyncDot` |
| Продуктовые | `EditorToolbar`, `MiniPlayer`, `TimecodeRow`, `Waveform`, `Diff`, `DiffInline`, `Tree` |
| Бренд | `ServiceMark` — знак сервиса из файла дизайн-системы, минимум 28 px |
| Иконки | `Icon*` — stroke 1.75, viewBox 24, `currentColor` |

Классы-утилиты для вёрстки экранов: `z-h1`, `z-h2`, `z-body`,
`z-editor-column`, `z-snippet`, `z-caption`, `z-mono`, `z-link`, `z-mark`,
`z-quote`, `z-code-block` + `z-tok-*`, `z-scroll-x`, `z-visually-hidden`,
`z-bottom-fade`.

## Витрина

```bash
pnpm --filter @zapiski/ui gallery        # dev-сервер со всеми компонентами
pnpm --filter @zapiski/ui gallery:build  # статическая сборка витрины
```

Страница — `src/gallery/Gallery.tsx`: все компоненты во всех состояниях,
переключатель 3 тем × 3 акцентов, живые настройки редактора.

## Проверки

```bash
pnpm --filter @zapiski/ui typecheck
pnpm --filter @zapiski/ui test           # контраст 18 сочетаний + поведение
node scripts/lint-tokens.mjs             # ни одного hex вне токенов
```

Контраст: `CONTRAST.md` — 270 замеров, 8 принятых отклонений с числами и
разбором. Реестр перечитан под палитру «Бумага · Гранат» заново и сейчас пуст.

## Шрифты и офлайн

Интерфейс и текст заметки — **Golos Text**, моно — **JetBrains Mono**
(`tz/ZAPISKI_TZ_1_Design.md` §1). Source Serif 4 остаётся только «бумажным»
режимом чтения заметки; в интерфейсной хромоте serif не появляется нигде.

Все три поставляются файлами: `src/fonts/*.woff2` + сгенерированный
`src/styles/fonts.css`. В рантайме нет ни одного обращения к CDN — приложение
обязано работать офлайн, а в Tauri внешний CDN просто недоступен.
`test/styles.test.ts` проверяет, что из графа стилей не торчит ни одного
`http(s)`-импорта и что объявленные `@font-face` — ровно эти три гарнитуры.

Подробности про файлы, лицензии и обновление — `src/fonts/README.md`.
