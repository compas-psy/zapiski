/**
 * Оформление редактора. Ни одного hex — только `var(--*)` (DESIGN_TOKENS §4).
 *
 * Ключевой момент всего пакета — правило `.cm-z-mark`:
 *
 *   символы разметки ВСЕГДА занимают место в потоке, меняется только
 *   `opacity` (BEHAVIOR §2.1, приёмочный критерий §13.3).
 *
 * Поэтому здесь нет ни одного `display: none`, ни одного `font-size: 0`,
 * ни одной `width`, зависящей от позиции курсора. Всё, что переключается
 * курсором, переключает исключительно `opacity`.
 *
 * `@starting-style` нужен потому, что CodeMirror пересоздаёт `span` при смене
 * класса декорации: без него новорождённый элемент появился бы сразу с
 * `opacity: 1` и перехода 160 мс не было бы видно.
 */

import { EditorView } from '@codemirror/view';
import { fontFamily } from './tokens.js';

/** Множители кегля заголовков относительно базового размера (DESIGN_TOKENS §2). */
const HEADING = [
  { size: '1.875', weight: '700', tracking: '-0.02em', lh: '1.2' }, // H1 30/16
  { size: '1.1875', weight: '600', tracking: '-0.01em', lh: '1.35' }, // H2 19/16
  { size: '1.0625', weight: '600', tracking: '-0.01em', lh: '1.4' }, // H3 17/16
  { size: '1', weight: '600', tracking: '0', lh: '1.45' }, // H4
  { size: '0.9375', weight: '600', tracking: '0.01em', lh: '1.5' }, // H5
  { size: '0.875', weight: '700', tracking: '0.04em', lh: '1.5' }, // H6
] as const;

function headingRules(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  HEADING.forEach((h, i) => {
    out[`.cm-z-h${i + 1}`] = {
      fontSize: `calc(var(--z-fs) * ${h.size})`,
      fontWeight: h.weight,
      letterSpacing: h.tracking,
      lineHeight: h.lh,
      // Заголовки различаются размером и насыщенностью, НЕ цветом
      // (DESIGN_TOKENS §2, «Правило markdown-вёрстки»).
      color: 'var(--text)',
    };
  });
  return out;
}

export const zapiskiBaseTheme = EditorView.baseTheme({
  '&': {
    // Настройки типографики (BEHAVIOR §10, DESIGN_TOKENS §2) — множители над
    // токенами, а не отдельные наборы значений. Значения переопределяет
    // `typographyTheme()`; здесь только умолчания.
    '--z-fs': '16px',
    '--z-lh': '1.65',
    '--z-col': '640px',
    '--z-face': fontFamily.sans,
    '--z-block-gap': '0.6em',
    '--z-pad-y': '36px',
    '--z-pad-x': '32px',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    fontFamily: 'var(--z-face)',
    fontSize: 'var(--z-fs)',
    lineHeight: 'var(--z-lh)',
  },
  '&.cm-focused': { outline: 'none' },

  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    overflowX: 'hidden',
  },
  '.cm-content': {
    maxWidth: 'var(--z-col)',
    marginInline: 'auto',
    padding: 'var(--z-pad-y) var(--z-pad-x) 40vh var(--z-pad-x)',
    caretColor: 'var(--accent)',
    /*
     * Рамка вокруг текста на Android.
     *
     * Гасить контур на `.cm-editor.cm-focused` недостаточно: фокус получает
     * `.cm-content` — это он `contenteditable`, — и Android WebView рисует
     * системный контур именно вокруг него. На десктопе его не видно, потому
     * что там фокус приходит с клавиатуры и рисуется наше кольцо.
     *
     * Подсветка нажатия убрана по той же причине: в тексте она выглядит
     * прямоугольной заливкой на пол-абзаца, а не «нажатием».
     */
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  // Raw-режим (Ctrl+E): сырой markdown моноширинным, без единой декорации.
  '.cm-content.cm-z-raw': { fontFamily: fontFamily.mono, fontSize: '0.9em' },
  '.cm-line': {
    padding: '0',
    // Абзацный ритм задаётся отступом, а не пустыми строками.
    marginBottom: '0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftWidth: '2px',
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--surface)' },
  '.cm-gutters': { display: 'none' },
  '.cm-placeholder': { color: 'var(--text-disabled)' },

  // ───────────────────────────────────────────────────────────────────────────
  // ФИРМЕННАЯ ДЕТАЛЬ: проявление разметки у курсора (DESIGN_TOKENS §3)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-mark': {
    color: 'var(--text-disabled)',
    opacity: '0',
    transition: 'opacity 160ms ease-out',
    // Никаких изменений метрики: символ занимает своё место всегда.
    fontWeight: 'inherit',
    fontStyle: 'inherit',
  },
  '.cm-z-mark-on': { opacity: '1' },
  '@starting-style': {
    // Плавное проявление даже когда CodeMirror пересоздал элемент.
    '.cm-z-mark-on': { opacity: '0' },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Блочные элементы
  // ───────────────────────────────────────────────────────────────────────────
  ...headingRules(),

  '.cm-z-paragraph-gap': { paddingTop: 'var(--z-block-gap)' },

  '.cm-z-strong': { fontWeight: '700' },
  '.cm-z-em': { fontStyle: 'italic' },
  '.cm-z-strike': { textDecoration: 'line-through', textDecorationColor: 'var(--text-tertiary)' },
  // DS-ALIGNMENT §10: подсветка НЕ акцентная — иначе она спорит с главным
  // действием за одно из двух разрешённых акцентных пятен на экране.
  '.cm-z-highlight': {
    backgroundColor: 'var(--mark-bg)',
    color: 'var(--text)',
    borderRadius: '4px',
    // padding не задаём: он сдвинул бы соседний текст.
  },

  '.cm-z-inline-code': {
    fontFamily: fontFamily.mono,
    fontSize: '0.87em',
    backgroundColor: 'var(--surface)',
    borderRadius: '6px',
  },

  '.cm-z-code': {
    fontFamily: fontFamily.mono,
    fontSize: '0.78em',
    lineHeight: '1.7',
    backgroundColor: 'var(--surface)',
    paddingInline: '14px',
  },
  '.cm-z-code-first': { paddingTop: '10px', borderRadius: '12px 12px 0 0' },
  '.cm-z-code-last': { paddingBottom: '10px', borderRadius: '0 0 12px 12px' },
  '.cm-z-code-first.cm-z-code-last': { borderRadius: '12px' },
  '.cm-z-code-info': { color: 'var(--text-tertiary)' },

  '.cm-z-quote': {
    borderLeft: '2.5px solid var(--text-disabled)',
    paddingLeft: '16px',
    fontStyle: 'italic',
    color: 'var(--text-secondary)',
  },

  '.cm-z-hr': { position: 'relative' },
  '.cm-z-hr::after': {
    content: '""',
    position: 'absolute',
    left: '0',
    right: '0',
    top: '50%',
    height: '1px',
    backgroundColor: 'var(--line)',
  },

  // Маркеры списков — акцентного цвета, деликатные (DESIGN_TOKENS §2).
  // DS-ALIGNMENT §10: маркеры списков и таймкоды — --text-tertiary, не акцент.
  '.cm-z-list-mark': { color: 'var(--text-tertiary)' },

  // ───────────────────────────────────────────────────────────────────────────
  // Таблицы GFM (SCREENS §4: шапка --surface, строки через --line, радиус 12)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-table': {
    fontFamily: fontFamily.mono,
    fontSize: '0.8em',
    lineHeight: '2',
    fontVariantNumeric: 'tabular-nums',
    borderLeft: '1px solid var(--line)',
    borderRight: '1px solid var(--line)',
    borderBottom: '1px solid var(--line)',
    paddingInline: '10px',
  },
  '.cm-z-table-head': {
    backgroundColor: 'var(--surface)',
    fontWeight: '600',
    borderTop: '1px solid var(--line)',
    borderRadius: '12px 12px 0 0',
  },
  '.cm-z-table-last': { borderRadius: '0 0 12px 12px' },
  '.cm-z-table-delim': { color: 'var(--line)' },

  // ───────────────────────────────────────────────────────────────────────────
  // Ссылки, wiki-ссылки, теги, сноски
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-link': {
    color: 'var(--accent)',
    textDecoration: 'underline',
    textDecorationStyle: 'dashed',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },
  '.cm-z-url': {
    fontFamily: fontFamily.mono,
    fontSize: '0.8em',
    color: 'var(--text-tertiary)',
  },
  '.cm-z-wiki': {
    color: 'var(--accent)',
    textDecoration: 'underline',
    textDecorationStyle: 'dashed',
    textDecorationThickness: '1px',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },
  // Висячая ссылка: тот же акцент, пунктир в половину непрозрачности
  // (BEHAVIOR §2.5).
  '.cm-z-wiki-dangling': { opacity: '0.5' },
  // DS-ALIGNMENT §10: чип тега ТЕРЯЕТ заливку — текст акцентом на прозрачном.
  // Заливка --accent-soft остаётся только у активного фильтра, а он живёт
  // в экранах, не в редакторе.
  '.cm-z-tag': {
    color: 'var(--accent)',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    /* Подчёркивания нет — §7 запрещает прямо: тег и так выделен цветом. */
    textDecoration: 'none',
  },
  /* Решётка — того же цвета, но приглушённая: читается имя тега, а не символ. */
  '.cm-z-tag-hash': { opacity: '0.6' },
  '.cm-z-footnote': {
    color: 'var(--accent)',
    fontSize: '0.8em',
    verticalAlign: 'super',
    lineHeight: '0',
  },
  '.cm-z-footnote-def': { color: 'var(--text-secondary)', fontSize: '0.9em' },

  // ───────────────────────────────────────────────────────────────────────────
  // Чекбоксы (BEHAVIOR §2.3, SCREENS §4: 18×18, радиус 6)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-task': {
    position: 'relative',
    display: 'inline-block',
    minWidth: '24px',
  },
  // Когда курсор внутри — показываем сырой `[x]` поверх нарисованного квадрата.
  '.cm-z-task.cm-z-mark-on': { backgroundColor: 'var(--bg)' },
  // Квадрат ЗАМЕЩАЕТ сырые `[ ]`, поэтому у него собственная ширина. Нулевая
  // была верна, пока скобки держали место прозрачными: виджет ложился в их
  // просвет. После схлопывания разметки нулевая ширина дала «☐адача» —
  // квадрат поверх первых букв.
  '.cm-z-taskbox': {
    position: 'relative',
    display: 'inline-block',
    width: '1.3em',
    height: '1em',
    verticalAlign: 'baseline',
  },
  '.cm-z-taskbox svg': {
    position: 'absolute',
    left: '0',
    top: '0.55em',
    width: '18px',
    height: '18px',
    transform: 'translateY(-50%)',
    cursor: 'pointer',
    overflow: 'visible',
  },
  // Touch-target ≥44 dp (DESIGN_TOKENS §3) — растём вверх/вниз и влево,
  // чтобы не перехватывать тап по тексту задачи (BEHAVIOR §2.3).
  '.cm-z-taskbox svg::before': {
    content: '""',
    position: 'absolute',
    top: '-13px',
    bottom: '-13px',
    left: '-13px',
    right: '-2px',
  },
  '.cm-z-taskbox rect': {
    fill: 'transparent',
    stroke: 'var(--text-disabled)',
    strokeWidth: '1.5',
    transition: 'fill 200ms ease-out, stroke 200ms ease-out',
  },
  '.cm-z-taskbox-checked rect': {
    fill: 'var(--accent)',
    stroke: 'var(--accent)',
  },
  '.cm-z-taskbox path': {
    fill: 'none',
    stroke: 'var(--bg)',
    strokeWidth: '2',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    strokeDasharray: '18',
    strokeDashoffset: '18',
    transition: 'stroke-dashoffset 160ms ease-out 60ms',
  },
  '.cm-z-taskbox-checked path': { strokeDashoffset: '0' },
  // Текст выполненной задачи (BEHAVIOR §2.3): secondary + line-through 200 мс.
  '.cm-z-task-done': {
    color: 'var(--text-secondary)',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--text-tertiary)',
    transition: 'color 200ms ease-out',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Изображения (BEHAVIOR §2.6)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-image-wrap': { display: 'block', width: '100%' },
  '.cm-z-image': {
    display: 'block',
    maxWidth: '100%',
    borderRadius: '12px',
    margin: '8px 0',
    // Тап открывает полноэкранный просмотр (ITERATION-1 §5) — курсор об этом
    // и сообщает; на телефоне подсказки нет, там об этом говорит сам жест.
    cursor: 'zoom-in',
  },
  '.cm-z-image-missing': {
    display: 'block',
    padding: '12px 14px',
    margin: '8px 0',
    borderRadius: '12px',
    backgroundColor: 'var(--surface)',
    color: 'var(--text-tertiary)',
    fontSize: '0.8em',
    fontFamily: fontFamily.mono,
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Файл и аудио в тексте (ITERATION-1 §5, «Как выглядит в тексте»)
  // ───────────────────────────────────────────────────────────────────────────
  // Оба блочные и стоят в конце строки — как превью картинки. Сама ссылка при
  // этом остаётся видимой: карточка ДОБАВЛЯЕТСЯ к тексту, а не подменяет его,
  // иначе исчезал бы адрес, который человек правит руками.
  '.cm-z-file': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    margin: '8px 0',
    padding: '12px 14px',
    borderRadius: '12px',
    border: '1px solid var(--line)',
    backgroundColor: 'var(--surface)',
    cursor: 'pointer',
  },
  '.cm-z-file__icon': {
    flex: '0 0 auto',
    width: '20px',
    height: '20px',
    fill: 'none',
    stroke: 'var(--text-secondary)',
    strokeWidth: '1.5',
    strokeLinejoin: 'round',
  },
  '.cm-z-file__name': {
    flex: '1 1 auto',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text-primary)',
  },
  '.cm-z-file__size': {
    flex: '0 0 auto',
    fontFamily: fontFamily.mono,
    fontSize: '11px',
    color: 'var(--text-tertiary)',
  },

  '.cm-z-audio': {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    margin: '8px 0',
    padding: '10px 14px',
    borderRadius: '12px',
    border: '1px solid var(--line)',
    backgroundColor: 'var(--surface)',
  },
  '.cm-z-audio__play': {
    flex: '0 0 auto',
    width: '34px',
    height: '34px',
    padding: '0',
    borderRadius: '50%',
    border: 'none',
    backgroundColor: 'var(--accent)',
    color: 'var(--on-accent)',
    fontSize: '13px',
    lineHeight: '34px',
    cursor: 'pointer',
  },
  // Полоса — 3 px, как в COMPONENTS §8. Заливка растёт по `inline-size`, а не
  // `transform`: масштабированная полоса размывает края на дробном пикселе.
  '.cm-z-audio__track': {
    flex: '1 1 auto',
    height: '3px',
    borderRadius: '2px',
    backgroundColor: 'var(--surface-sunken)',
    overflow: 'hidden',
  },
  '.cm-z-audio__fill': {
    display: 'block',
    height: '100%',
    inlineSize: '0%',
    borderRadius: '2px',
    backgroundColor: 'var(--accent)',
    transition: 'inline-size 120ms linear',
  },
  '.cm-z-audio__time': {
    flex: '0 0 auto',
    fontFamily: fontFamily.mono,
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },
  // Сам `<audio>` не показываем: элементов управления у него свои, системные,
  // и в каждой из трёх оболочек они выглядят по-разному.
  '.cm-z-audio audio': { display: 'none' },

  // ───────────────────────────────────────────────────────────────────────────
  // Режим фокуса (BEHAVIOR §2.8)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-focus-dim': { opacity: '0.28', transition: 'opacity 300ms ease-out' },
  '.cm-z-focus-active': { opacity: '1', transition: 'opacity 300ms ease-out' },

  // ───────────────────────────────────────────────────────────────────────────
  // Панель поиска и замены (BEHAVIOR §4, «3 из 12»)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-z-find': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    backgroundColor: 'var(--surface-alt)',
    borderBottom: '1px solid var(--line)',
    fontFamily: 'var(--z-face)',
    fontSize: '14px',
    flexWrap: 'wrap',
  },
  '.cm-z-find input': {
    flex: '1 1 140px',
    minWidth: '0',
    padding: '6px 10px',
    borderRadius: '10px',
    border: '1px solid var(--line)',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    font: 'inherit',
    outline: 'none',
  },
  '.cm-z-find input:focus': { borderColor: 'var(--accent)' },
  '.cm-z-find button': {
    padding: '6px 10px',
    borderRadius: '10px',
    border: '1px solid var(--line)',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.cm-z-find-count': {
    fontFamily: fontFamily.mono,
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    whiteSpace: 'nowrap',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--accent)',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Автодополнение тегов и wiki-ссылок (BEHAVIOR §2.4, §2.5)
  // ───────────────────────────────────────────────────────────────────────────
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--bg)',
    border: '1px solid var(--line)',
    borderRadius: '12px',
    overflow: 'hidden',
    fontFamily: 'var(--z-face)',
  },
  '.cm-tooltip-autocomplete ul li': {
    padding: '6px 12px',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent-on-soft, var(--text))',
  },
  '.cm-completionDetail': {
    fontStyle: 'normal',
    fontFamily: fontFamily.mono,
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    marginLeft: '8px',
  },

  // Статус вставки изображения (BEHAVIOR §2.6, тексты — §11).
  '.cm-z-inline-status': {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '10px',
    backgroundColor: 'var(--surface)',
    color: 'var(--text-secondary)',
    fontSize: '0.8em',
    fontFamily: fontFamily.mono,
  },

  // Подсказка режима фокуса (SCREENS §4).
  '.cm-z-focus-hint': {
    position: 'absolute',
    top: '12px',
    right: '16px',
    zIndex: '5',
    fontFamily: fontFamily.mono,
    fontSize: '10.5px',
    color: 'var(--text-disabled)',
    pointerEvents: 'none',
  },

  // Приёмочный критерий §13.9: при prefers-reduced-motion не проигрывается
  // ни одна анимация, функциональность полная.
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-z-mark, .cm-z-focus-dim, .cm-z-focus-active, .cm-z-task-done': {
      transition: 'none',
    },
    '.cm-z-taskbox rect, .cm-z-taskbox path': { transition: 'none' },
    '.cm-z-audio__fill': { transition: 'none' },
  },

  // Наведение — только там, где есть мышь. На Android WebView `:hover`
  // залипает на последнем тронутом элементе и не снимается (см. сторож
  // стилей в @zapiski/ui).
  '@media (hover: hover)': {
    '.cm-z-file:hover': { borderColor: 'var(--accent)' },
  },
});
