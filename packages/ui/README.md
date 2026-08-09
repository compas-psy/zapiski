# @zapiski/ui

Токен-слой (3 темы × 6 акцентов) и библиотека компонентов КОМПАС.ЗАПИСКИ.
React 19, TypeScript, обычный CSS с переменными — **без CSS-in-JS**: смена
темы и акцента происходит в рантайме без единого ререндера React.

Источники истины: `docs/spec/DESIGN_TOKENS.md`, `docs/spec/COMPONENTS.md`.
Здесь — только то, что нужно, чтобы этим пользоваться.

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
- `theme` — что реально применено.
- `accent` — `garnet | pine | gold | blueberry | heather | slate`.
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

1. **Ни одного hex вне `src/styles/tokens.css`.** Проверяет
   `node scripts/lint-tokens.mjs` (падает с кодом 1). Только `var(--*)`.
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
переключатель 3 тем × 6 акцентов, живые настройки редактора.

## Проверки

```bash
pnpm --filter @zapiski/ui typecheck
pnpm --filter @zapiski/ui test           # контраст 18 сочетаний + поведение
node scripts/lint-tokens.mjs             # ни одного hex вне токенов
```

Контраст: `CONTRAST.md` — таблица всех 18 сочетаний и три зафиксированных
отклонения, которые ждут решения дизайнера.

Шрифты: `src/fonts/README.md` — self-hosted `.woff2`, лицензии, обновление.
