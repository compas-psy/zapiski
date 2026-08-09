# `@zapiski/ui` — токены и компоненты

Дизайн-система: единственное место в репозитории, где живут значения цвета,
типографики и метрик, плюс библиотека React-компонентов, из которых собираются
все экраны.

Публичный API — `packages/ui/src/index.ts`. Пакет отдаётся **исходниками**
(`main: ./src/index.ts`), а не собранным `dist`: его CSS должен пройти через
сборщик приложения. Скрипт `build` здесь — это `tsc --noEmit`.

Peer-зависимости: React 19 и React DOM 19.

---

## Токен-слой

### Два независимых измерения

`DESIGN_TOKENS.md` §1: **3 темы × 6 акцентов = 18 валидных сочетаний**, каждое
обязано проходить контраст AA.

| Измерение | Атрибут на корне | Значения |
| --- | --- | --- |
| Тема (поверхность) | `data-theme` | `paper` (Бумага, светлая, по умолчанию) · `graphite` (Графит, тёмная) · `ink` (Чернила, OLED — истинный `#000`) |
| Акцент | `data-accent` | `garnet` (Гранат, по умолчанию) · `pine` (Хвоя) · `gold` (Золото) · `blueberry` (Черника) · `heather` (Вереск) · `slate` (Грифель) |
| Плотность | `data-density` | `comfortable` · `compact` |
| Гарнитура | `data-typeface` | `sans` · `serif` |

Плюс `system` как *предпочтение* пользователя — оно разрешается в `paper` или
`graphite` на стороне `ThemeProvider`; в CSS всегда попадает конкретная тема.

### Файлы

```
src/styles/
  index.css        порядок: tokens → fonts → base → typography
  tokens.css       ЕДИНСТВЕННЫЙ файл, где разрешены цветовые литералы
  fonts.css        @font-face, self-hosted .woff2, без CDN в рантайме
  base.css         сброс, фокус-кольцо, прокрутка, prefers-reduced-motion
  typography.css   роли текста из DESIGN_TOKENS §2
```

`tokens.css` разбит на разделы: (1) не зависящее от темы — типографика,
spacing, радиусы, motion; (2) темы; (3) функциональные цвета; (4) акценты
таблицей 1:1 из ТЗ; (5) производные от акцента; (6) тени.

Размеры шрифтов заданы **в `rem`**, чтобы масштаб шрифта ОС до 200% не ломал
layout (ТЗ §6). В комментарии рядом — исходное значение из спецификации в px.

Пользовательские настройки редактора — **множители над базовыми токенами**, а
не отдельные наборы значений:

```css
--editor-font-scale: 1;   /* 14→.875 · 15→.9375 · 16→1 · 18→1.125 · 20→1.25 */
--editor-line-scale: 1;   /* 1.45→.87879 · 1.65→1 · 1.85→1.12121 */
--editor-measure: 40rem;  /* 640 / 720 / none */
```

Производные цвета получены через `color-mix()` **от токенов**, а не выдуманы
новыми hex-литералами; каждое такое место в файле помечено словом
«производное».

### Правило «ни одного hex вне токенов»

Инвариант `ARCHITECTURE.md` §3.4 и пункт B5 приёмочного листа. Проверяется
линтером:

```bash
pnpm lint:tokens        # node scripts/lint-tokens.mjs
```

Линтер обходит `packages/*/src/**` и `apps/*/src/**`, ищет `#rgb`, `#rgba`,
`#rrggbb`, `#rrggbbaa`, `rgb(`, `rgba(`, `hsl(`, `hsla(` и падает на любом
совпадении. Единственное исключение — `packages/ui/src/styles/tokens.css`.
Шаг «Линт токенов» есть в CI (`deploy-zapiski.yml`), падение валит сборку.

На момент сверки линтер зелёный: 135 файлов, нарушений нет. Правило
распространяется и на печатный CSS экспорта в `packages/core` — исключений для
«документа, который покидает приложение» не делается.

### API темизации

```tsx
import { ThemeProvider, useTheme, themeInitScriptTag } from '@zapiski/ui';

<ThemeProvider>          {/* по умолчанию читает localStorage 'zapiski.appearance' */}
  <App />
</ThemeProvider>

const { preference, theme, accent, editor, prefersDark, prefersReducedMotion,
        setTheme, setAccent, setEditor, reset } = useTheme();
```

| Экспорт | Что делает |
| --- | --- |
| `ThemeProvider` | Применяет тему в layout-эффекте — до первого кадра, поэтому нет белой вспышки. Слушает `prefers-color-scheme` и `prefers-reduced-motion`, пишет в `localStorage` |
| `useTheme` / `useOptionalTheme` | Доступ к состоянию и сеттерам |
| `applyAppearance(root, state, { prefersDark })` | Пишет `data-*` и CSS-переменные на элемент. **Только атрибуты — ни одного ререндера React**, поэтому смена темы не стоит ничего |
| `themeInitScript` / `themeInitScriptTag` | Строка для инлайна в `<head>` оболочки: ставит `data-theme` до первого кадра при SSR/статике |
| `parseAppearance` / `readStoredAppearance` / `writeStoredAppearance` | Терпимый разбор сохранённого состояния: любое повреждение → значения по умолчанию |
| `editorCssVariables(state)` | Три множителя выше |
| `resolveTheme(preference, prefersDark)` | `system` → `paper` / `graphite` |

Константы: `THEMES`, `THEME_PREFERENCES`, `ACCENTS`, `EDITOR_FONT_SIZES`,
`EDITOR_LINE_HEIGHTS`, `EDITOR_COLUMN_WIDTHS`, `BASE_FONT_SIZE`,
`BASE_LINE_HEIGHT`, `DEFAULT_APPEARANCE`, `DEFAULT_EDITOR_PREFERENCES`,
`APPEARANCE_STORAGE_KEY`.

Смена темы — кроссфейд 200 мс без белой вспышки; при `prefers-reduced-motion`
переходы отключены в `base.css`.

### Контраст

`packages/ui/test/contrast.test.ts` считает контраст **по настоящему
`tokens.css`** для всех 18 комбинаций по пяти парам: `--text`/`--bg`,
`--text`/`--surface`, `--text-secondary`/`--bg`, `--accent`/`--bg`,
`--accent-on-soft`/`--accent-soft`.

> ⚠️ **DoD «все 18 комбинаций проходят 4.5:1» пока не выполняется.** Тест
> честно фиксирует 8 известных отклонений в реестре `KNOWN_DEVIATIONS`:
>
> | Комбинация | Пара | Измерено |
> | --- | --- | --- |
> | `paper` × любой акцент (6 шт.) | `--text-secondary` / `--bg` | 3.6 |
> | `paper` × `gold` | `--accent` / `--bg` | 3.25 |
> | `paper` × `gold` | `--accent-on-soft` / `--accent-soft` | 4.19 |
>
> Это значения из самого `DESIGN_TOKENS.md` — решение за дизайнером. Тест
> падает и в обратную сторону: если отклонение исчезло, реестр пора обновить.
> Развёрнутое описание каждого отклонения — в `packages/ui/CONTRAST.md`.

---

## Компоненты

Общее правило: высота интерактивного элемента ≥44 px, состояния
hover / press / focus / disabled у каждого, press — `scale(0.97)` 120 мс,
focus-кольцо 3 px акцента только при клавиатурной навигации (`:focus-visible`).

Стили лежат в `.css` рядом с компонентом и импортируются из
`src/styles/index.css` через сам компонент; классы — `zpsk-*`.

| Группа | Компоненты | Ключевые пропсы |
| --- | --- | --- |
| Кнопки | `Button`, `IconButton` | `variant` (`primary`/`secondary`/`outline`/`text`/`danger`), `size`, `loading`, `loadingLabel`, `iconStart`, `iconEnd`, `fullWidth`; у `IconButton` — `icon`, `label` (обязателен для screen reader), `tone` |
| Поля | `TextField`, `SearchField`, `CodeInput`, `PinDots` | `label`, `hint`, `error`, `showError` (ошибка после blur, не во время набора), `leading`, `trailing`, `mono`; `SearchField.onClear`; `CodeInput`: `length`, `masked`, `onComplete`; `PinDots`: `filled`, `length` |
| Чипы | `Tag`, `FilterChip`, `ChipRow`, `Badge` | `Tag.variant` (`accent`/`outline`/`surface`); `FilterChip`: `active`, `onReset`, `resetLabel`; `ChipRow.scrollable` (горизонтальный скролл вместо переноса); `Badge.tone` |
| Переключатели | `Switch`, `Checkbox`, `Radio`, `RadioGroup`, `SegmentedControl` | `Checkbox.strikeWhenChecked`; `SegmentedControl`: `options`, `value`, `onChange`, `label` |
| Списки | `List`, `ListRow`, `SectionLabel` | `ListRow`: `title`, `snippet`, `snippetMuted`, `meta`, `marks`, `leading`, `trailing`, `selected`, `compact`, `swipeLeft`, `swipeRight` |
| Оверлеи | `BottomSheet`, `Modal`, `Drawer`, `Toast`, `ToastProvider`, `Tooltip` | Все: `open`, `onClose`, `label`; `Drawer.side`, `Drawer.scrim`; `Modal.wide`; `Tooltip.below`, `Tooltip.delay` |
| Обратная связь | `Spinner`, `Progress`, `Skeleton`, `SkeletonList`, `InfoNote`, `EmptyState`, `SyncDot` | `Progress.value` (нет значения — неопределённый прогресс); `Skeleton.variant`; `EmptyState`: `icon`, `title`, `description`, `action` (**ровно одна кнопка**); `SyncDot.status` |
| Специальные | `EditorToolbar`, `MiniPlayer`, `TimecodeRow`, `Waveform`, `Diff`, `DiffInline`, `Tree` | `Tree`: `nodes`, `selectedId`, `onSelect`, `expandedIds`, `onToggle`, `defaultExpandedIds`; `Diff.lines` |
| Иконки | 30 штук, stroke 1.75, viewBox 24, `currentColor` | `IconAlert`, `IconArrowLeft`, `IconBold`, `IconCheck`, `IconCheckSquare`, `IconChevronDown`, `IconChevronRight`, `IconClock`, `IconClose`, `IconFolder`, `IconHash`, `IconHeading`, `IconImage`, `IconInfo`, `IconItalic`, `IconList`, `IconLock`, `IconMic`, `IconMoon`, `IconMore`, `IconPaperclip`, `IconPause`, `IconPen`, `IconPin`, `IconPlay`, `IconPlus`, `IconRefresh`, `IconSearch`, `IconSun`, `IconTrash`, `IconUnlock` |

Отдельно стоит запомнить:

* **`ToastProvider` + `useToast`.** Один тост одновременно, живёт
  `TOAST_DURATION_MS = 6000`, новый вытесняет предыдущий (вытесненная операция
  считается подтверждённой — `BEHAVIOR.md` §0). Тост не блокирует ввод.
* **Свайпы `ListRow`.** Порог `SWIPE_THRESHOLD = 96` px, максимальное смещение
  132. До порога подложка проявляется пропорционально; отпускание до порога
  **никогда не выполняет действие** — приёмочный критерий C4.
* **`Tooltip`** появляется с задержкой `TOOLTIP_DELAY_MS = 500`.
* Все оверлеи закрываются по Esc и возвращают фокус на вызвавший элемент
  (общий хук `internal/useOverlay.ts`).

> ⏳ `MiniPlayer`, `Waveform` и `TimecodeRow` — компоненты для функции «Голос →
> Markdown» (`VOICE.md`, P1). Сама функция не реализована: это готовые
> кирпичи без сценария.

### Витрина

```bash
pnpm --filter @zapiski/ui gallery
```

`Gallery` — экспортируемый компонент со всеми элементами библиотеки в обеих
темах и всех акцентах. Это артефакт приёмки B1 («любой экран узнаваем как
семейство КОМПАС без логотипа») и самый быстрый способ увидеть изменение
токена глазами.

---

## Как добавить компонент

1. **Проверьте, что ни один существующий не подходит.** Требование ТЗ §6:
   новый компонент вводится только если ни один существующий не годится.
2. **Опишите его в `docs/spec/COMPONENTS.md`** — до кода. Это чужой документ,
   правка согласуется с владельцем ТЗ.
3. Создайте `src/components/<Группа>/<Имя>.tsx` и, если нужно, `<Группа>.css`.
   Импорт CSS — из самого компонента.
4. **Ни одного hex.** Только `var(--*)` из `tokens.css`. Не хватает токена —
   он добавляется в `tokens.css` со ссылкой на строку `DESIGN_TOKENS.md`.
5. **Ни одной строки интерфейса внутри.** Все подписи приходят пропсами; поля
   вроде `label` у `IconButton` и оверлеев обязательны именно поэтому.
6. Состояния hover / press / focus-visible / disabled — все четыре.
7. Touch-target ≥44 px, `prefers-reduced-motion` не ломает функциональность.
8. Экспортируйте компонент и его `Props` из `src/index.ts`.
9. Добавьте в `src/gallery/Gallery.tsx` и в `test/components.test.tsx`.
10. `pnpm --filter @zapiski/ui test && pnpm lint:tokens`.
