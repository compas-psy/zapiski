# @zapiski/ui

Токен-слой (3 темы × 6 акцентов) и библиотека компонентов ЗАПИСОК.
React 19, TypeScript, обычный CSS с переменными — **без CSS-in-JS**: смена
темы и акцента происходит в рантайме без единого ререндера React.

Токены — **алиасы поверх дизайн-системы СИМПАС**, а не отдельная палитра.
Снимок системы лежит в `src/styles/simpas/` (побайтовая копия, править нельзя);
подключается он через наш слой `src/styles/simpas-offline.css` — см. «Шрифты и
офлайн» ниже. Компоненты, одноимённые системным, помечены в коде как
«РЕАЛИЗАЦИЯ ДО ПОЯВЛЕНИЯ ПАКЕТА СИМПАС».

Источники истины по убыванию: `docs/spec/DS-ALIGNMENT.md` → `BEHAVIOR.md` →
`SCREENS.md` → `DESIGN_TOKENS.md`. Карта соответствия компонентов —
`DS-MAPPING.md` рядом с этим файлом.

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

- `preference` — что выбрал пользователь: `system | simpas | graphite | ink`
  (по умолчанию `system`: светлая ОС → `simpas`, тёмная → `graphite`;
  `ink` только вручную). Переживает перезапуск (localStorage).
- `theme` — что реально применено. `simpas` — светлая тема дизайн-системы,
  базовая и единственная «дневная»; `graphite` и `ink` — наше расширение.
- `accent` — `pine | forest | gold | dusk | granite | clay` (Хвоя, Лес,
  Золото, Сумерки, Гранит, Глина). По умолчанию `pine`. Терракоты в наборе
  нет: это цвет идентичности, а не интерфейса.
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
переключатель 3 тем × 6 акцентов, живые настройки редактора.

## Проверки

```bash
pnpm --filter @zapiski/ui typecheck
pnpm --filter @zapiski/ui test           # контраст 18 сочетаний + поведение
node scripts/lint-tokens.mjs             # ни одного hex вне токенов
```

Контраст: `CONTRAST.md` — 270 замеров, 8 принятых отклонений с числами и
разбором. Реестр перечитан под палитру СИМПАСА заново.

## Шрифты и офлайн

Интерфейс — **Geist**, моно — **Geist Mono** (`DS-ALIGNMENT §6`). Source Serif 4
остаётся только режимом чтения заметки; в интерфейсе serif не появляется нигде.

Снимок системы тянет Geist из Google Fonts
(`simpas/vendor/tokens/fonts.css`), а нам нужен полный офлайн. Каталог `vendor/`
не правится, поэтому наш `src/styles/simpas-offline.css` повторяет список
импортов системы **без** `tokens/fonts.css` и подставляет self-hosted
`src/styles/fonts.css`. Список не даёт себе разойтись со снимком: `test/simpas.test.ts`
сверяет его с `vendor/styles.css` и отдельно проверяет, что из графа стилей не
торчит ни одного `http(s)`-импорта.

Подробности про файлы, лицензии и обновление — `src/fonts/README.md`.
