/**
 * Панель форматирования (ITERATION-1 §4).
 *
 * Прежний тулбар был рядом плоских кнопок в две строки: форматировать можно
 * было только тем, что в него влезло, а что именно сейчас применено — не
 * видно. Для простого режима (§8), где разметки в тексте нет вовсе, этого
 * недостаточно принципиально: панель там — единственный способ форматировать.
 *
 * Форма — три группы-пилюли в одну строку:
 *
 *     [ ↶  ↷ ]   [ Aa │ B │ ☰ │ ⊞ │ 🔗 │ 📎 │ Σ ]   [ ☺ ]
 *
 * Присланный референс задаёт паттерн взаимодействия — плавающие пилюли с
 * выпадающими меню, — но не внешний вид: цвета, радиусы и тени наши.
 *
 * Три правила, каждое из §4 и каждое легко потерять:
 *
 *  1. В меню, где выбирается один вариант из набора, ТЕКУЩИЙ помечен
 *     галочкой. «Текст» и «Без списка» — полноценные варианты, а не
 *     отсутствие действия.
 *  2. Кнопка подсвечена, пока её меню открыто.
 *  3. Панель не уводит фокус из текста: после нажатия курсор возвращается на
 *     ту же позицию. Поэтому кнопки работают по `mousedown` с
 *     `preventDefault`, а не по `click`.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { StyleModule } from 'style-mod';
import { StateEffect } from '@codemirror/state';

import { ru, type EditorStrings } from '../i18n.js';
import { blockStyleAt, listStyleAt, type BlockStyle, type ListStyle } from '../commands/block-state.js';
import {
  insertCodeBlock,
  insertDivider,
  insertLink,
  insertTable,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleTaskList,
} from '../commands/formatting.js';
import { insertCallout, insertCollapsible, insertSmall } from '../commands/blocks.js';


/* ── Стили ────────────────────────────────────────────────────────────────
   Всё в токенах: §4 говорит «панель наша», и ни одного литерала цвета здесь
   быть не может. Числа — из §4 дословно: контейнер 44, кнопка 36, радиус 10,
   иконка 19, разделитель 20, зазор между группами 10. */
const styles = new StyleModule({
  '.zp-panel': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    userSelect: 'none',
    color: 'var(--text-secondary)',
    /* На телефоне кнопок больше, чем ширины экрана. Перенос на вторую строку
       ломает форму «одна строка пилюль» и съедает высоту у текста — панель
       прокручивается вбок. Полоса прокрутки скрыта: она здесь только мешает. */
    maxWidth: '100%',
    overflowX: 'auto',
    scrollbarWidth: 'none',
    paddingBottom: '2px',
  },
  '.zp-panel::-webkit-scrollbar': { display: 'none' },
  '.zp-panel__pill': {
    /* Пилюля не сжимается: при прокрутке вбок кнопки обязаны сохранять
       размер, иначе на узком экране они молча превратятся в полоски. */
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    height: '44px',
    padding: '0 4px',
    borderRadius: 'var(--r-full)',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    boxShadow: 'var(--shadow-card, var(--elev-search))',
  },
  '.zp-panel__anchor': { position: 'relative', display: 'inline-flex' },
  '.zp-panel__btn': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    margin: '0',
    padding: '0',
    border: '0',
    borderRadius: '10px',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    transition: 'transform var(--dur-fast, 120ms) var(--ease-out, ease)',
  },
  '.zp-panel__btn:active': { transform: 'scale(.97)' },
  '.zp-panel__btn--active': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent-on-soft)',
  },
  '@media (hover: hover)': {
    '.zp-panel__btn:hover': { backgroundColor: 'var(--surface-alt)' },
    '.zp-panel__btn--active:hover': { backgroundColor: 'var(--accent-soft)' },
    '.zp-panel__item:hover': { backgroundColor: 'var(--surface-alt)' },
    '.zp-panel__emoji:hover': { backgroundColor: 'var(--surface-alt)' },
  },
  /* Разделитель — хайрлайн высотой 20, а не отступ (§4). */
  '.zp-panel__divider': {
    width: '1px',
    height: '20px',
    margin: '0 2px',
    backgroundColor: 'var(--line)',
  },

  '.zp-panel__menu': {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    left: '0',
    zIndex: '20',
    minWidth: '232px',
    padding: '6px',
    borderRadius: 'var(--r-card)',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    boxShadow: 'var(--shadow-pop, var(--elev-modal))',
    /* Появление 160 мс: fade + 6 px снизу, точка роста — у кнопки (§4). */
    transformOrigin: 'top left',
    animation: 'zp-panel-in 160ms var(--ease-out, ease)',
  },
  '@keyframes zp-panel-in': {
    from: { opacity: '0', transform: 'translateY(6px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  '.zp-panel__item': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    height: '40px',
    padding: '0 10px',
    border: '0',
    borderRadius: '8px',
    background: 'transparent',
    color: 'var(--text)',
    font: 'inherit',
    fontSize: 'var(--fs-md, 15px)',
    textAlign: 'start',
    cursor: 'pointer',
  },
  '.zp-panel__item--separated': {
    marginTop: '5px',
    paddingTop: '5px',
    borderTop: '1px solid var(--line)',
  },
  '.zp-panel__item--back': { color: 'var(--text-secondary)' },
  '.zp-panel__label': { flex: '1', minWidth: '0' },
  '.zp-panel__hotkey': {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-tertiary)',
  },
  '.zp-panel__index': {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--text-secondary)',
    minWidth: '18px',
  },
  '.zp-panel__check': { color: 'var(--accent)', fontSize: '16px' },
  /* Палитра эмодзи: сетка вместо списка — символы читаются глазом, а не
     подписью, и восемь в ряд помещаются на самом узком экране. */
  '.zp-panel__menu--emoji': {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 1fr)',
    gap: '2px',
    minWidth: '0',
    right: '0',
    left: 'auto',
    transformOrigin: 'top right',
  },
  '.zp-panel__emoji': {
    width: '34px',
    height: '34px',
    border: '0',
    borderRadius: '8px',
    background: 'transparent',
    fontSize: '20px',
    lineHeight: '1',
    cursor: 'pointer',
  },

  '.zp-panel__chevron': { color: 'var(--text-tertiary)' },

  /* Пункты подменю набраны реальными кеглями H1…H6 — человек видит результат,
     а не читает название (§4). Высота строки при этом растёт вместе с кеглем,
     поэтому фиксированная высота 40 здесь снимается. */
  '.zp-panel__item--h1': { height: 'auto', fontSize: 'var(--fs-h1)', fontWeight: 'var(--fw-h1)' },
  '.zp-panel__item--h2': { height: 'auto', fontSize: 'var(--fs-h2)', fontWeight: 'var(--fw-h2)' },
  '.zp-panel__item--h3': { height: 'auto', fontSize: 'var(--fs-h3)', fontWeight: 'var(--fw-h3)' },
  '.zp-panel__item--h4': { fontSize: 'var(--fs-lg, 17px)', fontWeight: '600' },
  '.zp-panel__item--h5': { fontSize: 'var(--fs-md, 15px)', fontWeight: '600' },
  '.zp-panel__item--h6': { fontSize: 'var(--fs-sm, 13px)', fontWeight: '600' },
});

let mounted = false;
function ensureStyles(): void {
  if (mounted || typeof document === 'undefined') return;
  StyleModule.mount(document, styles);
  mounted = true;
}

export interface FormatPanelProps {
  /** Представление редактора; пока его нет, панель неактивна. */
  view: EditorView | null;
  strings?: EditorStrings;
  /** Вложения (§5). Пункт скрывается, если обработчика нет. */
  onAttach?: (kind: 'image' | 'file' | 'audio') => void;
  /** Вставка ссылки диалогом приложения. */
  onLink?: () => void;
  /** Формула LaTeX. Кнопки нет, пока KaTeX не в сборке (§4). */
  onFormula?: () => void;
  /** Палитра эмодзи. */
  onEmoji?: () => void;
  className?: string;
}

/** Какое меню раскрыто. `heading` — вложенное, оно занимает место родителя. */
type OpenMenu = null | 'style' | 'heading' | 'weight' | 'list' | 'attach' | 'emoji';

export function FormatPanel({
  view,
  strings = ru,
  onAttach,
  onLink,
  onFormula,
  onEmoji,
  className,
}: FormatPanelProps): ReactElement {
  ensureStyles();
  const copy = strings.panel;
  const [open, setOpen] = useState<OpenMenu>(null);
  const [tick, setTick] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  /* Панель отражает текст под курсором, а он меняется от каждого нажатия
     клавиши и от каждого клика — поэтому перерисовываемся по обновлениям
     представления, а не по своему состоянию. */
  useEffect(() => {
    if (!view) return;
    /* Расширение добавляется в уже собранное состояние через `appendConfig` —
       это единственный способ, не пересоздающий его: пересоздание стоило бы
       истории отмены и позиции курсора. */
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.updateListener.of((update) => {
          if (update.docChanged || update.selectionSet) setTick((value) => value + 1);
        }),
      ),
    });
  }, [view]);

  /* Esc закрывает меню и возвращает фокус в текст (§4). */
  useEffect(() => {
    if (!view || open === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(null);
      view.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, open]);

  /* Клик мимо панели закрывает меню — иначе оно висит поверх текста. */
  useEffect(() => {
    if (open === null) return;
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const style: BlockStyle = view ? blockStyleAt(view.state) : 'text';
  const list: ListStyle = view ? listStyleAt(view.state) : 'none';
  void tick;

  /** Выполнить команду и вернуть курсор в текст — §4, «панель не берёт фокус». */
  const run = (command: (target: EditorView) => boolean) => (): void => {
    if (!view) return;
    command(view);
    setOpen(null);
    view.focus();
  };

  const menuFor = (which: Exclude<OpenMenu, null>) => (): void =>
    setOpen((current) => (current === which ? null : which));

  /** Вставка символа на позицию курсора — эмодзи это обычный текст. */
  const insertText = (text: string): void => {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.type',
    });
    setOpen(null);
    view.focus();
  };

  return (
    <div
      ref={root}
      className={className ? `zp-panel ${className}` : 'zp-panel'}
      role="toolbar"
      aria-label={copy.label}
    >
      <Pill>
        <PanelButton label={copy.undo} onPress={run(undo)}>
          <IconUndo />
        </PanelButton>
        <PanelButton label={copy.redo} onPress={run(redo)}>
          <IconRedo />
        </PanelButton>
      </Pill>

      <Pill>
        <MenuButton
          label={copy.blockStyle}
          expanded={open === 'style' || open === 'heading'}
          onPress={menuFor('style')}
          menu={
            open === 'style' ? (
              <Menu>
                <MenuItem
                  label={copy.styles.heading}
                  submenu
                  checked={style.startsWith('h')}
                  onPress={() => setOpen('heading')}
                />
                <MenuItem
                  label={copy.styles.text}
                  hotkey={copy.hotkeys.text}
                  checked={style === 'text'}
                  onPress={run(setHeading(0))}
                />
                <MenuItem
                  label={copy.styles.quote}
                  hotkey={copy.hotkeys.quote}
                  checked={style === 'quote'}
                  onPress={run(toggleQuote)}
                />
                <MenuItem
                  label={copy.styles.callout}
                  checked={style === 'callout'}
                  onPress={run(insertCallout)}
                />
                <MenuItem
                  label={copy.styles.code}
                  hotkey={copy.hotkeys.code}
                  checked={style === 'code'}
                  onPress={run(insertCodeBlock)}
                />
                <MenuItem
                  label={copy.styles.small}
                  checked={style === 'small'}
                  onPress={run(insertSmall)}
                />
                {/* Разделитель — вставка, а не стиль: отделён хайрлайном. */}
                <MenuItem label={copy.styles.divider} separated onPress={run(insertDivider)} />
              </Menu>
            ) : open === 'heading' ? (
              <Menu>
                <MenuItem label={copy.back} back onPress={() => setOpen('style')} />
                {[1, 2, 3, 4, 5, 6].map((level) => (
                  <MenuItem
                    key={level}
                    label={copy.headingLevel(level)}
                    /* Пункт набран своим реальным кеглем: человек видит
                       результат, а не читает название (§4). */
                    sample={`h${level}`}
                    index={`H${SUBSCRIPT[level - 1] ?? ''}`}
                    checked={style === `h${level}`}
                    onPress={run(setHeading(level))}
                  />
                ))}
              </Menu>
            ) : null
          }
        >
          <IconStyle />
        </MenuButton>

        <Divider />

        <MenuButton
          label={copy.weight}
          expanded={open === 'weight'}
          onPress={run(toggleBold)}
          onLongPress={menuFor('weight')}
          menu={
            open === 'weight' ? (
              <Menu>
                <MenuItem
                  label={copy.weights.bold}
                  hotkey={copy.hotkeys.bold}
                  onPress={run(toggleBold)}
                />
                <MenuItem
                  label={copy.weights.italic}
                  hotkey={copy.hotkeys.italic}
                  onPress={run(toggleItalic)}
                />
                <MenuItem label={copy.weights.strike} onPress={run(toggleStrike)} />
                <MenuItem label={copy.weights.highlight} onPress={run(toggleHighlight)} />
                <MenuItem label={copy.weights.mono} onPress={run(toggleInlineCode)} />
              </Menu>
            ) : null
          }
        >
          <IconBold />
        </MenuButton>

        <Divider />

        <MenuButton
          label={copy.lists}
          expanded={open === 'list'}
          onPress={menuFor('list')}
          menu={
            open === 'list' ? (
              <Menu>
                <MenuItem
                  label={copy.listKinds.none}
                  checked={list === 'none'}
                  onPress={run(clearList)}
                />
                <MenuItem
                  label={copy.listKinds.bullet}
                  hotkey={copy.hotkeys.bullet}
                  checked={list === 'bullet'}
                  onPress={run(toggleBulletList)}
                />
                <MenuItem
                  label={copy.listKinds.ordered}
                  hotkey={copy.hotkeys.ordered}
                  checked={list === 'ordered'}
                  onPress={run(toggleOrderedList)}
                />
                <MenuItem
                  label={copy.listKinds.task}
                  hotkey={copy.hotkeys.task}
                  checked={list === 'task'}
                  onPress={run(toggleTaskList)}
                />
                <MenuItem
                  label={copy.listKinds.details}
                  checked={list === 'details'}
                  onPress={run(insertCollapsible)}
                />
              </Menu>
            ) : null
          }
        >
          <IconList />
        </MenuButton>

        <Divider />

        <PanelButton label={copy.table} onPress={run(insertTable)}>
          <IconTable />
        </PanelButton>

        <Divider />
        {/* Ссылка есть всегда: без обработчика — командой редактора, которая
            вставляет `[текст]()` и ставит курсор внутрь скобок для адреса.
            Приложение может подменить это диалогом «Текст» + «Адрес» (§4). */}
        <PanelButton
          label={copy.link}
          onPress={
            onLink
              ? () => {
                  setOpen(null);
                  onLink();
                }
              : run(insertLink)
          }
        >
          <IconLink />
        </PanelButton>

        {onAttach ? (
          <>
            <Divider />
            <MenuButton
              label={copy.attachment}
              expanded={open === 'attach'}
              onPress={menuFor('attach')}
              menu={
                open === 'attach' ? (
                  <Menu>
                    {(['image', 'file', 'audio'] as const).map((kind) => (
                      <MenuItem
                        key={kind}
                        label={copy.attachments[kind]}
                        onPress={() => {
                          setOpen(null);
                          onAttach(kind);
                        }}
                      />
                    ))}
                  </Menu>
                ) : null
              }
            >
              <IconClip />
            </MenuButton>
          </>
        ) : null}

        {/* Формула — только если KaTeX в сборке (§4): иначе кнопки нет вовсе,
            а не есть и не работает. */}
        {onFormula ? (
          <>
            <Divider />
            <PanelButton
              label={copy.formula}
              onPress={() => {
                setOpen(null);
                onFormula();
              }}
            >
              <IconSigma />
            </PanelButton>
          </>
        ) : null}
      </Pill>

      <Pill>
        <MenuButton
          label={copy.emoji}
          expanded={open === 'emoji'}
          onPress={
            onEmoji
              ? () => {
                  setOpen(null);
                  onEmoji();
                }
              : menuFor('emoji')
          }
          menu={
            open === 'emoji' ? (
              <div className="zp-panel__menu zp-panel__menu--emoji" role="menu">
                {EMOJI.map((symbol) => (
                  <button
                    key={symbol}
                    type="button"
                    role="menuitem"
                    className="zp-panel__emoji"
                    aria-label={symbol}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      insertText(symbol);
                    }}
                    onTouchStart={(event) => {
                      event.preventDefault();
                      insertText(symbol);
                    }}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
            ) : null
          }
        >
          <IconSmile />
        </MenuButton>
      </Pill>
    </div>
  );
}

/**
 * Палитра эмодзи.
 *
 * Короткая и осознанно: это вставка в ТЕКСТ пользователя, а не украшение
 * интерфейса, — запрет на эмодзи в UI она не нарушает. Полноценный
 * системный выбор с поиском и категориями сюда не тянем: в вебе его нет, а
 * своя копия таблицы Unicode весит больше, чем стоит.
 */
const EMOJI = [
  '✅', '❗', '❓', '⭐', '🔥', '💡', '📌', '📎',
  '📅', '⏰', '📈', '📉', '💰', '🎯', '🧩', '🔒',
  '🙂', '😐', '😕', '👍', '👎', '🙏', '💬', '🤔',
] as const;

/** Индексы уровней в подменю заголовков: H₁…H₆. */
const SUBSCRIPT = ['₁', '₂', '₃', '₄', '₅', '₆'];

/** «Без списка» — снятие любого списочного маркера. */
const clearList = (target: EditorView): boolean => {
  const style = listStyleAt(target.state);
  if (style === 'bullet') return toggleBulletList(target);
  if (style === 'ordered') return toggleOrderedList(target);
  if (style === 'task') return toggleTaskList(target);
  return false;
};

function Pill({ children }: { children: ReactNode }): ReactElement {
  return <div className="zp-panel__pill">{children}</div>;
}

/** Хайрлайн между группами кнопок — не отступ (§4). */
function Divider(): ReactElement {
  return <span className="zp-panel__divider" aria-hidden="true" />;
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  active?: boolean;
  children: ReactNode;
}

/**
 * Кнопка панели.
 *
 * `mousedown` с `preventDefault` вместо `click`: иначе редактор теряет фокус,
 * на Android схлопывается клавиатура, а курсор уезжает с той позиции, к
 * которой человек применял формат.
 */
function PanelButton({ label, onPress, active, children }: ButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={`zp-panel__btn${active ? ' zp-panel__btn--active' : ''}`}
      aria-label={label}
      title={label}
      onMouseDown={(event) => {
        event.preventDefault();
        onPress();
      }}
      onTouchStart={(event) => {
        event.preventDefault();
        onPress();
      }}
    >
      {children}
    </button>
  );
}

interface MenuButtonProps extends ButtonProps {
  expanded: boolean;
  menu: ReactNode;
  /** Долгое нажатие / правый клик — для кнопок с действием и меню сразу. */
  onLongPress?: () => void;
}

function MenuButton({
  label,
  onPress,
  onLongPress,
  expanded,
  menu,
  children,
}: MenuButtonProps): ReactElement {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Долгое нажатие уже сработало — отпускание не должно делать ещё и обычное. */
  const consumed = useRef(false);

  const start = (): void => {
    consumed.current = false;
    if (!onLongPress) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      consumed.current = true;
      onLongPress();
    }, 450);
  };
  /** `true` — отпускание считается обычным нажатием. */
  const finish = (): boolean => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    /* Кнопка без долгого нажатия таймера не заводит вовсе — и раньше её
       обычный клик из-за этого не срабатывал ни разу. */
    return !consumed.current;
  };

  return (
    <span className="zp-panel__anchor">
      <button
        type="button"
        /* Кнопка подсвечена, пока её меню открыто (§4, правило 2). */
        className={`zp-panel__btn${expanded ? ' zp-panel__btn--active' : ''}`}
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        aria-haspopup="menu"
        onMouseDown={(event) => {
          event.preventDefault();
          start();
        }}
        onMouseUp={() => {
          if (finish()) onPress();
        }}
        onMouseLeave={() => finish()}
        onTouchStart={(event) => {
          event.preventDefault();
          start();
        }}
        onTouchEnd={() => {
          if (finish()) onPress();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onLongPress?.();
        }}
      >
        {children}
      </button>
      {menu}
    </span>
  );
}

function Menu({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="zp-panel__menu" role="menu">
      {children}
    </div>
  );
}

interface MenuItemProps {
  label: string;
  onPress: () => void;
  /** Текущий вариант помечен галочкой (§4, правило 1). */
  checked?: boolean;
  hotkey?: string;
  /** Ведёт во вложенное меню — шеврон справа. */
  submenu?: boolean;
  /** Строка «← Назад» вложенного меню. */
  back?: boolean;
  /** Отделён хайрлайном сверху: вставка среди стилей. */
  separated?: boolean;
  /** Набрать пункт реальным кеглем этого уровня. */
  sample?: string;
  /** Моноширинный индекс слева: H₁…H₆. */
  index?: string;
}

function MenuItem({
  label,
  onPress,
  checked,
  hotkey,
  submenu,
  back,
  separated,
  sample,
  index,
}: MenuItemProps): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      aria-checked={checked === undefined ? undefined : checked}
      className={[
        'zp-panel__item',
        separated ? 'zp-panel__item--separated' : '',
        back ? 'zp-panel__item--back' : '',
        sample ? `zp-panel__item--${sample}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onMouseDown={(event) => {
        event.preventDefault();
        onPress();
      }}
      onTouchStart={(event) => {
        event.preventDefault();
        onPress();
      }}
    >
      {back ? <span className="zp-panel__chevron">←</span> : null}
      {index ? <span className="zp-panel__index">{index}</span> : null}
      <span className="zp-panel__label">{label}</span>
      {hotkey ? <span className="zp-panel__hotkey">{hotkey}</span> : null}
      {submenu ? <span className="zp-panel__chevron">›</span> : null}
      {checked ? (
        <span className="zp-panel__check" aria-hidden="true">
          ✓
        </span>
      ) : null}
    </button>
  );
}

/* ── Иконки: 19, stroke 1.75 (§4) ─────────────────────────────────────────── */

const ICON = {
  width: 19,
  height: 19,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const IconUndo = (): ReactElement => (
  <svg {...ICON}>
    <path d="M3 8h11a5 5 0 0 1 0 10H8" />
    <path d="M6 4 3 8l3 4" />
  </svg>
);
const IconRedo = (): ReactElement => (
  <svg {...ICON}>
    <path d="M21 8H10a5 5 0 0 0 0 10h6" />
    <path d="m18 4 3 4-3 4" />
  </svg>
);
const IconStyle = (): ReactElement => (
  <svg {...ICON}>
    <path d="M4 19 9 5l5 14" />
    <path d="M5.8 15h6.4" />
    <path d="M17 19v-7a2.5 2.5 0 0 1 3 0" />
  </svg>
);
const IconBold = (): ReactElement => (
  <svg {...ICON}>
    <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
    <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
  </svg>
);
const IconList = (): ReactElement => (
  <svg {...ICON}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </svg>
);
const IconTable = (): ReactElement => (
  <svg {...ICON}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M9 10v9M15 10v9" />
  </svg>
);
const IconLink = (): ReactElement => (
  <svg {...ICON}>
    <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
  </svg>
);
const IconClip = (): ReactElement => (
  <svg {...ICON}>
    <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l8-8" />
  </svg>
);
const IconSigma = (): ReactElement => (
  <svg {...ICON}>
    <path d="M18 5H6l6 7-6 7h12" />
  </svg>
);
const IconSmile = (): ReactElement => (
  <svg {...ICON}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </svg>
);
