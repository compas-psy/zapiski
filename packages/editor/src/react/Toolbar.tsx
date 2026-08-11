/**
 * Тулбар над клавиатурой (BEHAVIOR §2.7, SCREENS §4).
 *
 * Высота 44, элементы 34×34, `space-between`, иконки 19, фон `--surface-alt`,
 * верхняя граница 1 px. Одна строка: H · B · I · список · чекбокс · фото ·
 * «⋯». «H» — циклическое H1→H2→H3→обычный. «⋯» открывает вторую строку:
 * цитата, код, таблица, разделитель, ссылка, сноска, wiki-ссылка.
 *
 * Микрофона здесь НЕТ — решение Р4 мастер-ТЗ: «Голос → Markdown = P1.
 * Микрофон убирается из тулбара v1. Пустая кнопка „скоро“ в самом частом
 * месте интерфейса хуже её отсутствия». Освободившееся место отдано «⋯»
 * (tz/ZAPISKI_TZ_1_Design.md §1.4). Модель данных под голос при этом
 * заложена заранее (`2_Engineering.md` §12) — задел архитектурный, а не
 * кнопочный.
 *
 * Без выделения B/I вставляют парные маркеры и ставят курсор между ними —
 * это поведение живёт в `toggleWrap`, тулбар о нём не знает.
 */

import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { StyleModule } from 'style-mod';
import type { EditorView } from '@codemirror/view';

import { ru } from '../i18n.js';
import type { EditorStrings } from '../i18n.js';
import {
  cycleHeading,
  insertCodeBlock,
  insertDivider,
  insertFootnote,
  insertLink,
  insertTable,
  insertWikiLink,
  toggleBold,
  toggleBulletList,
  toggleItalic,
  toggleQuote,
  toggleTaskList,
} from '../commands/formatting.js';
import {
  IconBold,
  IconCode,
  IconDivider,
  IconFootnote,
  IconHeading,
  IconItalic,
  IconLink,
  IconList,
  IconMore,
  IconPhoto,
  IconQuote,
  IconTable,
  IconTask,
  IconWiki,
} from './icons.js';

const styles = new StyleModule({
  '.zpsk-toolbar': {
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: 'var(--surface-alt)',
    borderTop: '1px solid var(--line)',
    color: 'var(--text)',
    userSelect: 'none',
  },
  '.zpsk-toolbar-row': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: '44px',
    paddingInline: '8px',
    gap: '2px',
  },
  '.zpsk-toolbar-row + .zpsk-toolbar-row': { borderTop: '1px solid var(--line)' },
  '.zpsk-toolbar-btn': {
    // Touch-target: визуально 34×34, но растянут по высоте строки до 44 dp.
    width: '34px',
    height: '44px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-secondary)',
    borderRadius: '10px',
    cursor: 'pointer',
    transition: 'transform 120ms ease-out, color 120ms ease-out',
  },
  '.zpsk-toolbar-btn:active': { transform: 'scale(0.97)', color: 'var(--accent)' },
  '.zpsk-toolbar-btn[aria-pressed="true"]': { color: 'var(--accent)' },
  '@media (prefers-reduced-motion: reduce)': {
    '.zpsk-toolbar-btn': { transition: 'none' },
  },
});

let mounted = false;
function ensureStyles(): void {
  if (mounted || typeof document === 'undefined') return;
  StyleModule.mount(document, styles);
  mounted = true;
}

export interface ToolbarProps {
  /** Представление редактора; пока его нет, кнопки неактивны. */
  view: EditorView | null;
  /** Вставка фото: выбор из галереи или камера (BEHAVIOR §2.6). */
  onPhoto?: () => void;
  strings?: EditorStrings;
  className?: string;
}

function Button({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      className="zpsk-toolbar-btn"
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      // mousedown/touchstart вместо click: иначе редактор теряет фокус и
      // на Android схлопывается клавиатура.
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      onTouchStart={(event) => {
        event.preventDefault();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function Toolbar({ view, onPhoto, strings = ru, className }: ToolbarProps): ReactElement {
  ensureStyles();
  const [more, setMore] = useState(false);

  const run = (command: (view: EditorView) => boolean) => () => {
    if (!view) return;
    command(view);
    view.focus();
  };

  return (
    <div className={className ? `zpsk-toolbar ${className}` : 'zpsk-toolbar'} role="toolbar">
      <div className="zpsk-toolbar-row">
        <Button label={strings.toolbar.heading} onClick={run(cycleHeading)}>
          <IconHeading />
        </Button>
        <Button label={strings.toolbar.bold} onClick={run(toggleBold)}>
          <IconBold />
        </Button>
        <Button label={strings.toolbar.italic} onClick={run(toggleItalic)}>
          <IconItalic />
        </Button>
        <Button label={strings.toolbar.bulletList} onClick={run(toggleBulletList)}>
          <IconList />
        </Button>
        <Button label={strings.toolbar.task} onClick={run(toggleTaskList)}>
          <IconTask />
        </Button>
        <Button label={strings.toolbar.photo} onClick={() => onPhoto?.()}>
          <IconPhoto />
        </Button>
        <Button label={strings.toolbar.more} pressed={more} onClick={() => setMore((v) => !v)}>
          <IconMore />
        </Button>
      </div>

      {more ? (
        <div className="zpsk-toolbar-row">
          <Button label={strings.toolbar.quote} onClick={run(toggleQuote)}>
            <IconQuote />
          </Button>
          <Button label={strings.toolbar.code} onClick={run(insertCodeBlock)}>
            <IconCode />
          </Button>
          <Button label={strings.toolbar.table} onClick={run(insertTable)}>
            <IconTable />
          </Button>
          <Button label={strings.toolbar.divider} onClick={run(insertDivider)}>
            <IconDivider />
          </Button>
          <Button label={strings.toolbar.link} onClick={run(insertLink)}>
            <IconLink />
          </Button>
          <Button label={strings.toolbar.footnote} onClick={run(insertFootnote)}>
            <IconFootnote />
          </Button>
          <Button label={strings.toolbar.wikiLink} onClick={run(insertWikiLink)}>
            <IconWiki />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
