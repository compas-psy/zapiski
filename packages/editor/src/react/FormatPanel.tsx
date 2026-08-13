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
import { createPortal } from 'react-dom';
import {
  autoUpdate,
  flip,
  limitShift,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react-dom';
import { EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { StyleModule } from 'style-mod';
import { StateEffect } from '@codemirror/state';

import { ru, type EditorStrings } from '../i18n.js';
import { HEADING } from '../theme/base-theme.js';
import {
  blockStyleAt,
  inlineActiveAt,
  listStyleAt,
  type BlockStyle,
  type ListStyle,
} from '../commands/block-state.js';
import {
  insertCodeBlock,
  insertDivider,
  insertTable,
  setHeading,
  toggleBold,
  bulletListWith,
  toggleBulletList,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleOrderedList,
  toggleQuote,
  toggleStrike,
  toggleTaskList,
} from '../commands/formatting.js';
import {
  insertCallout,
  insertCollapsible,
  insertQuoteAuthor,
  insertSmall,
} from '../commands/blocks.js';
import { applyLink, linkDraft } from '../commands/link.js';
import { tableAt } from '../commands/table.js';
import { TableDialog, tableDialogStyles } from './TableDialog.js';


/* ── Стили ────────────────────────────────────────────────────────────────
   Всё в токенах: §4 говорит «панель наша», и ни одного литерала цвета здесь
   быть не может. Числа — из §4 дословно: контейнер 44, кнопка 36, радиус 10,
   иконка 19, разделитель 20, зазор между группами 10. */
/**
 * Кегли пунктов H1…H6 в подменю заголовков.
 *
 * §4: «Каждый пункт набран своим РЕАЛЬНЫМ кеглем и весом — пользователь видит
 * результат, а не читает название». Значит, источник у превью и у текста
 * обязан быть один; им и служит `HEADING` из темы редактора.
 *
 * База — `--fs-body` (16), а не `--z-fs`: последний объявлен внутри
 * `.cm-editor`, а меню живёт вне него, и множитель просто не посчитался бы.
 */
function headingSamples(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  HEADING.forEach((h, index) => {
    out[`.zp-panel__item--h${index + 1}`] = {
      /* Крупным пунктам высота строки 40 мала — иначе H1 обрежется. */
      ...(index < 3 ? { height: 'auto', paddingBlock: '6px' } : {}),
      fontSize: `calc(var(--fs-body) * ${h.size})`,
      fontWeight: h.weight,
      letterSpacing: h.tracking,
    };
  });
  return out;
}

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
    boxShadow: 'var(--shadow-card)',
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
    transition: 'transform var(--dur-press) var(--ease-out, ease)',
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

  /* ── Слой меню ───────────────────────────────────────────────────────────
     Меню рисуется ПОРТАЛОМ в `document.body`, а не внутри панели, и позицию
     ему считает Floating UI.

     Почему так, а не `position: absolute` у якоря, как было. У самой панели
     стоит `overflow-x: auto` (ради узкого экрана), и по CSS вторая ось при
     этом тоже вычисляется в `auto` — панель стала скролл-контейнером и
     обрезала меню по своей высоте 46 px, тогда как верх меню начинался на
     48-й. Меню не было видно НИ ОДНИМ пикселем: в DOM оно есть, на экране
     нет. Сверху добавлялся второй клип — `overflow: hidden` у `.za-editor` —
     и стекинг-контекст от `position: sticky` у обёртки панели, из-за которого
     `z-index` меню действовал только внутри неё.

     Портал снимает все три разом, и его же документация Floating UI называет
     самым надёжным способом против обрезания. */
  '.zp-panel__layer': {
    position: 'fixed',
    zIndex: 'var(--z-overlay)',
    /* Появление 160 мс: fade + 6 px со стороны кнопки (§4). Направление зависит
       от того, куда меню в итоге раскрылось. */
    animation: 'zp-panel-in 160ms var(--ease-out, ease)',
  },
  '.zp-panel__layer[data-side="top"]': {
    animationName: 'zp-panel-in-up',
    transformOrigin: 'bottom left',
  },
  '@keyframes zp-panel-in': {
    from: { opacity: '0', transform: 'translateY(6px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  '@keyframes zp-panel-in-up': {
    from: { opacity: '0', transform: 'translateY(-6px)' },
    to: { opacity: '1', transform: 'translateY(0)' },
  },
  '.zp-panel__menu': {
    minWidth: '232px',
    /* Длинное меню на низком экране прокручивается внутри себя, а не уезжает
       за кромку. Значение ставит `size()` из Floating UI по доступному месту;
       фолбэк — на случай, если слой почему-то отрисовался до первого счёта. */
    maxHeight: 'var(--zp-menu-max, 60vh)',
    overflowY: 'auto',
    padding: '6px',
    borderRadius: 'var(--r-card)',
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--line)',
    boxShadow: 'var(--shadow-pop)',
    transformOrigin: 'top left',
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
    fontSize: 'var(--fs-md)',
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
  '.zp-panel__glyph': { flex: 'none', color: 'var(--text-secondary)' },
  '.zp-panel__check': { color: 'var(--accent)', fontSize: '16px' },
  /* Удаление — своим цветом и последним пунктом за хайрлайном (§4). */
  '.zp-panel__item--danger': {
    color: 'var(--danger-text)',
    marginTop: '5px',
    paddingTop: '5px',
    borderTop: '1px solid var(--line)',
  },
  '.zp-panel__group': {
    padding: '6px 10px 2px',
    fontSize: '11px',
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
  },
  '.zp-panel__group--separated': {
    marginTop: '5px',
    paddingTop: '9px',
    borderTop: '1px solid var(--line)',
  },
  /* Выравнивание — отдельной плашкой над списком действий, как в §4. */
  '.zp-panel__aligns': { display: 'flex', gap: '2px', padding: '2px 6px 4px' },
  '.zp-panel__align': {
    flex: '1',
    height: '36px',
    border: '0',
    borderRadius: '8px',
    background: 'transparent',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  '.zp-panel__align--on': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--accent-on-soft)',
  },
  /* Палитра эмодзи: сетка вместо списка — символы читаются глазом, а не
     подписью, и восемь в ряд помещаются на самом узком экране. */
  '.zp-panel__menu--emoji': {
    display: 'grid',
    gridTemplateColumns: 'repeat(8, 1fr)',
    gap: '2px',
    minWidth: '0',
  },
  /* Вкладки наборов — во всю ширину палитры, отдельной строкой над сеткой. */
  '.zp-panel__emoji-tabs': {
    gridColumn: '1 / -1',
    display: 'flex',
    gap: '2px',
    paddingBottom: '4px',
    marginBottom: '2px',
    borderBottom: '1px solid var(--line)',
  },
  '.zp-panel__emoji-tab': {
    flex: '1',
    border: '0',
    background: 'transparent',
    borderRadius: '8px',
    padding: '4px 0',
    fontSize: '16px',
    lineHeight: '1',
    cursor: 'pointer',
    opacity: '0.55',
  },
  '.zp-panel__emoji-tab--on': { opacity: '1', backgroundColor: 'var(--surface-alt)' },
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

  /* Диалог ссылки: два поля и две кнопки. Меню в этом же слое, поэтому
     размеры и тень те же — иначе он читался бы как чужой элемент. */
  '.zp-panel__menu--link': { display: 'grid', gap: '8px', padding: '10px' },
  '.zp-panel__field': { display: 'grid', gap: '4px' },
  '.zp-panel__field label': {
    fontSize: '11px',
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
  },
  '.zp-panel__input': {
    height: '36px',
    padding: '0 10px',
    borderRadius: '8px',
    border: '1px solid var(--line)',
    backgroundColor: 'var(--surface-sunken)',
    color: 'var(--text)',
    font: 'inherit',
    fontSize: 'var(--fs-md)',
  },
  '.zp-panel__input:focus-visible': {
    outline: '2px solid var(--focus-ring, var(--accent))',
    outlineOffset: '1px',
  },
  '.zp-panel__actions': { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
  '.zp-panel__action': {
    height: '34px',
    padding: '0 14px',
    borderRadius: '8px',
    border: '1px solid var(--line)',
    backgroundColor: 'transparent',
    color: 'var(--text)',
    font: 'inherit',
    cursor: 'pointer',
  },
  '.zp-panel__action--primary': {
    borderColor: 'transparent',
    backgroundColor: 'var(--accent)',
    color: 'var(--on-accent)',
  },

  '.zp-panel__chevron': { color: 'var(--text-tertiary)' },

  /* Пункты подменю набраны реальными кеглями H1…H6 — человек видит результат,
     а не читает название (§4). Высота строки при этом растёт вместе с кеглем,
     поэтому фиксированная высота 40 здесь снимается. */
  /* Кегли берутся из ТОЙ ЖЕ шкалы, по которой редактор рисует заголовки, —
     иначе превью обещает одно, а текст получается другой. Раньше здесь стояли
     свои значения, причём три из шести ссылались на несуществующие токены
     `--fs-h3`/`--fw-h3` и молча набирались как попало. */
  ...headingSamples(),

  /* Редактор таблицы: живёт в этом же модуле, чтобы тень, радиусы и токены
     у него были те же, что у меню и диалога ссылки. */
  ...tableDialogStyles,
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
  /**
   * Символ маркерного списка из настроек (замечание 10). Меняет ТЕКСТ файла,
   * поэтому приходит из приложения, а не из темы редактора: тема отвечает за
   * показ, а это разметка.
   */
  bulletMarker?: '-' | '*' | '+';
  strings?: EditorStrings;
  /** Вложения (§5). Пункт скрывается, если обработчика нет. */
  onAttach?: (kind: 'image' | 'file' | 'audio') => void;
  /** Вставка ссылки диалогом приложения. */
  onLink?: () => void;
  /** Формула LaTeX. Кнопки нет, пока KaTeX не в сборке (§4). */
  onFormula?: () => void;
  /** Палитра эмодзи. */
  onEmoji?: () => void;
  /**
   * Отменяемое действие (§4: «Удаление строки и столбца — ОО: тост „Строка
   * удалена · Отменить“»). Тосты рисует приложение — в редакторе их нет и не
   * должно быть: он не знает ни про слои поверх экрана, ни про очередь
   * сообщений. Без обработчика удаление просто откатывается по Ctrl+Z.
   */
  onUndoable?: (message: string, undo: () => void) => void;
  className?: string;
}

/** Какое меню раскрыто. `heading` — вложенное, оно занимает место родителя. */
type OpenMenu =
  | null
  | 'style'
  | 'heading'
  | 'weight'
  | 'list'
  | 'attach'
  | 'emoji'
  | 'table'
  | 'link';

export function FormatPanel({
  view,
  strings = ru,
  onAttach,
  onLink,
  onFormula,
  onEmoji,
  onUndoable,
  bulletMarker = '-',
  className,
}: FormatPanelProps): ReactElement {
  ensureStyles();
  const copy = strings.panel;
  const [open, setOpen] = useState<OpenMenu>(null);
  /* Какая группа эмодзи открыта. Держится между открытиями палитры: человек
     обычно берёт символы из одного набора подряд. */
  const [emojiGroup, setEmojiGroup] = useState(0);
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

  /* Нажатие мимо панели закрывает меню — иначе оно висит поверх текста.
     `pointerdown`, а не `mousedown`: на тач-устройстве до совместимостного
     `mousedown` дело доходит не всегда, и закрытие работало через раз. */
  useEffect(() => {
    if (open === null) return;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      /* Меню теперь живёт порталом в `document.body`, то есть ВНЕ поддерева
         панели: проверять только `root` значило бы закрывать меню от нажатия
         внутри него самого. */
      const inside =
        root.current?.contains(target as Node) || target?.closest?.('.zp-panel__layer');
      if (!inside) setOpen(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  /* Таблица под курсором: от неё зависит поведение кнопки — вставить новую
     или открыть редактор той, что уже есть. Сама правка живёт в
     `TableDialog`, вместе с тостом «Отменить» на удаление. */
  const table = view ? tableAt(view.state) : null;

  const style: BlockStyle = view ? blockStyleAt(view.state) : 'text';
  const list: ListStyle = view ? listStyleAt(view.state) : 'none';
  /* Начертания под курсором (§4, «Поведение»): курсор внутри жирного → «B»
     подсвечена. Без этого кнопка говорила только про своё меню, а не про
     текст, — и понять, что уже применено, было нельзя. */
  const inline = view
    ? inlineActiveAt(view.state)
    : { bold: false, italic: false, strike: false, highlight: false, code: false };
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
                  glyph="heading"
                  submenu
                  checked={style.startsWith('h')}
                  onPress={() => setOpen('heading')}
                />
                <MenuItem
                  label={copy.styles.text}
                  glyph="text"
                  hotkey={copy.hotkeys.text}
                  checked={style === 'text'}
                  onPress={run(setHeading(0))}
                />
                <MenuItem
                  label={copy.styles.quote}
                  glyph="quote"
                  hotkey={copy.hotkeys.quote}
                  checked={style === 'quote'}
                  onPress={run(toggleQuote)}
                />
                {/* Автор цитаты (замечание 4). Пункт живёт под самой цитатой
                    и виден всегда: пустая атрибуция места в просмотре не
                    занимает, поэтому предлагать её не страшно. */}
                <MenuItem
                  label={copy.styles.quoteAuthor}
                  glyph="quote"
                  onPress={run(insertQuoteAuthor)}
                />
                <MenuItem
                  label={copy.styles.callout}
                  glyph="callout"
                  checked={style === 'callout'}
                  onPress={run(insertCallout)}
                />
                <MenuItem
                  label={copy.styles.code}
                  glyph="code"
                  hotkey={copy.hotkeys.code}
                  checked={style === 'code'}
                  onPress={run(insertCodeBlock)}
                />
                <MenuItem
                  label={copy.styles.small}
                  glyph="small"
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
          /* Подсвечена и когда открыто меню, и когда курсор внутри жирного. */
          active={inline.bold}
          onPress={run(toggleBold)}
          onLongPress={menuFor('weight')}
          menu={
            open === 'weight' ? (
              <Menu>
                <MenuItem
                  label={copy.weights.bold}
                  glyph="bold"
                  hotkey={copy.hotkeys.bold}
                  checked={inline.bold}
                  onPress={run(toggleBold)}
                />
                <MenuItem
                  label={copy.weights.italic}
                  glyph="italic"
                  hotkey={copy.hotkeys.italic}
                  checked={inline.italic}
                  onPress={run(toggleItalic)}
                />
                <MenuItem
                  label={copy.weights.strike}
                  glyph="strike"
                  checked={inline.strike}
                  onPress={run(toggleStrike)}
                />
                <MenuItem
                  label={copy.weights.highlight}
                  glyph="highlight"
                  checked={inline.highlight}
                  onPress={run(toggleHighlight)}
                />
                <MenuItem
                  label={copy.weights.mono}
                  glyph="mono"
                  checked={inline.code}
                  onPress={run(toggleInlineCode)}
                />
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
                  glyph="listNone"
                  checked={list === 'none'}
                  onPress={run(clearList)}
                />
                <MenuItem
                  label={copy.listKinds.bullet}
                  glyph="listBullet"
                  hotkey={copy.hotkeys.bullet}
                  checked={list === 'bullet'}
                  onPress={run(bulletListWith(bulletMarker))}
                />
                <MenuItem
                  label={copy.listKinds.ordered}
                  glyph="listOrdered"
                  hotkey={copy.hotkeys.ordered}
                  checked={list === 'ordered'}
                  onPress={run(toggleOrderedList)}
                />
                <MenuItem
                  label={copy.listKinds.task}
                  glyph="listTask"
                  hotkey={copy.hotkeys.task}
                  checked={list === 'task'}
                  onPress={run(toggleTaskList)}
                />
                <MenuItem
                  label={copy.listKinds.details}
                  glyph="listDetails"
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

        {/*
          Таблица. Вне таблицы кнопка вставляет 3×3, внутри — открывает
          редактор: вся таблица целиком, с ручками строк и столбцов
          (ITERATION-1 §4).

          Раньше здесь было меню, и правило в нём было одно: «сделать что-то
          с той ячейкой, где стоит курсор». Заказчик попросил виджет по
          образцу диалога ссылки — и он прав: переставить строку, не видя
          таблицы и не помня, где каретка, нельзя. Диалог встаёт у каретки,
          а не у кнопки: панель может быть далеко внизу у клавиатуры.
        */}
        <MenuButton
          label={copy.table}
          expanded={open === 'table'}
          anchorToCaret={() => caretRect(view)}
          onPress={table ? menuFor('table') : run(insertTable)}
          menu={
            open === 'table' && table && view ? (
              <TableDialog
                copy={copy}
                view={view}
                {...(onUndoable ? { onUndoable } : {})}
                onClose={() => setOpen(null)}
              />
            ) : null
          }
        >
          <IconTable />
        </MenuButton>

        <Divider />
        {/* Ссылка — диалог «Текст» + «Адрес» с предзаполнением из выделения
            (§4). Приложение может подменить его своим через `onLink`; без
            этого работает встроенный. */}
        <MenuButton
          label={copy.link}
          expanded={open === 'link'}
          /* Диалог встаёт у каретки, а не у кнопки: панель может быть далеко
             внизу у клавиатуры, и «вставить ссылку сюда» превращалось во
             «всплыло где-то вверху». */
          anchorToCaret={() => caretRect(view)}
          onPress={
            onLink
              ? () => {
                  setOpen(null);
                  onLink();
                }
              : () => setOpen((current) => (current === 'link' ? null : 'link'))
          }
          menu={
            open === 'link' && view ? (
              <LinkDialog
                copy={copy}
                view={view}
                onClose={() => {
                  setOpen(null);
                  view.focus();
                }}
              />
            ) : null
          }
        >
          <IconLink />
        </MenuButton>

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
                        glyph={kind}
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
          /* Палитра у правого края панели: прижимаем вправо, иначе `shift()`
             будет каждый раз оттаскивать её от кнопки. */
          menuPlacement="bottom-end"
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
                <div className="zp-panel__emoji-tabs">
                  {EMOJI_GROUPS.map((group, index) => (
                    <button
                      key={group.tab}
                      type="button"
                      className={`zp-panel__emoji-tab${index === emojiGroup ? ' zp-panel__emoji-tab--on' : ''}`}
                      aria-pressed={index === emojiGroup}
                      aria-label={copy.emojiGroup(index + 1)}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        setEmojiGroup(index);
                      }}
                    >
                      {group.tab}
                    </button>
                  ))}
                </div>
                {(EMOJI_GROUPS[emojiGroup] ?? EMOJI_GROUPS[0]).items.map((symbol) => (
                  <button
                    key={symbol}
                    type="button"
                    role="menuitem"
                    className="zp-panel__emoji"
                    aria-label={symbol}
                    onPointerDown={(event) => {
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
/**
 * Эмодзи по группам (замечание 15).
 *
 * Было двадцать четыре штуки одним рядом — заказчик справедливо назвал набор
 * скудным и попросил «подгрузку пакетов, как в Telegram».
 *
 * Пакетов из сети здесь не будет, и это осознанно: приложение обязано
 * работать в самолёте (ТЗ §10), а догружаемый набор — это либо запрос к
 * чужому серверу в момент, когда человек просто хочет поставить смайлик, либо
 * молчаливый отказ. Вместо этого набор вырос вшестеро и разложен по группам с
 * вкладками — то, ради чего пакеты и нужны: найти нужное быстро.
 *
 * Порядок групп — от рабочего к личному: заметки чаще про дела, чем про
 * настроение.
 */
const EMOJI_GROUPS = [
  {
    tab: '✅',
    items: [
      '✅', '❌', '❗', '❓', '⭐', '🔥', '💡', '📌',
      '📎', '📅', '⏰', '🎯', '🧩', '🔒', '🔑', '⚡',
      '✔️', '➕', '➖', '🔁', '⏳', '🚩', '🏁', '📍',
    ],
  },
  {
    tab: '📈',
    items: [
      '📈', '📉', '📊', '💰', '💳', '🧾', '📦', '🛒',
      '🏦', '💼', '📁', '📂', '🗂️', '📝', '📄', '📋',
      '🖇️', '📚', '🔍', '🧮', '⚖️', '🏷️', '📬', '🗃️',
    ],
  },
  {
    tab: '🙂',
    items: [
      '🙂', '😀', '😄', '😅', '😂', '😉', '😊', '😍',
      '🤩', '😎', '🤗', '🤔', '😐', '😕', '😢', '😭',
      '😤', '😳', '🥱', '😴', '🤒', '🤯', '🥳', '😇',
    ],
  },
  {
    tab: '👍',
    items: [
      '👍', '👎', '👌', '✌️', '🤝', '🙏', '👏', '💪',
      '🫶', '👀', '🧠', '❤️', '💔', '💬', '🗣️', '👋',
      '🤞', '☝️', '✍️', '🫡', '🙌', '🤲', '💯', '🎉',
    ],
  },
  {
    tab: '🌿',
    items: [
      '🌿', '🌱', '🌳', '🌸', '🌞', '🌙', '⛅', '🌧️',
      '❄️', '🌊', '🔥', '🏔️', '🐈', '🐕', '🐦', '🦋',
      '🍎', '🍞', '☕', '🍵', '🍷', '🍫', '🥗', '🍲',
    ],
  },
  {
    tab: '🎵',
    items: [
      '🎵', '🎧', '🎬', '📷', '🎨', '✏️', '📖', '🎓',
      '🏃', '🚲', '✈️', '🚗', '🏠', '🛏️', '🧘', '🎁',
      '🕐', '📞', '💻', '📱', '🖨️', '🔋', '🛠️', '🧹',
    ],
  },
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
 *
 * ── Почему `pointerdown`, а не пара `mousedown` + `touchstart` ─────────────
 *
 * Пара была ошибкой, и дорогой. React регистрирует `touchstart` на корне как
 * ПАССИВНЫЙ слушатель, поэтому `preventDefault()` внутри `onTouchStart` не
 * делает ничего: браузер спокойно досылает совместимостные `mousedown` и
 * `mouseup`. На одно касание пальцем `onPress` вызывался ДВАЖДЫ — одно
 * нажатие «Отменить» откатывало два шага, а меню открывалось и тут же
 * закрывалось само собой. Ровно это заказчик и увидел: «при клике на кнопки
 * не открываются контекстные меню» — одинаково на телефоне и на планшете.
 *
 * `pointerdown` — один поток для мыши, пера и пальца, без дублей; и здесь
 * `preventDefault()` работает, то есть обещание «панель не уводит фокус из
 * текста» наконец выполняется и на Android.
 */
function PanelButton({ label, onPress, active, children }: ButtonProps): ReactElement {
  return (
    <button
      type="button"
      className={`zp-panel__btn${active ? ' zp-panel__btn--active' : ''}`}
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
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
  /** Куда прижимать меню. Палитре эмодзи — вправо: она у правого края панели. */
  menuPlacement?: 'bottom-start' | 'bottom-end';
  /**
   * Прижать меню не к кнопке, а к КУРСОРУ в тексте.
   *
   * Нужно диалогу ссылки. Панель форматирования стоит у клавиатуры или под
   * шапкой — далеко от того места, куда человек вставляет ссылку, — и диалог
   * открывался «где-то вверху», как заказчик и написал. Возвращает
   * прямоугольник каретки в координатах окна либо `null`, если каретки нет
   * (тогда прижимаемся к кнопке, как обычно).
   */
  anchorToCaret?: () => DOMRect | null;
  /** Долгое нажатие / правый клик — для кнопок с действием и меню сразу. */
  onLongPress?: () => void;
}

function MenuButton({
  label,
  onPress,
  onLongPress,
  expanded,
  active,
  menu,
  menuPlacement = 'bottom-start',
  anchorToCaret,
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

  /**
   * Позиция меню — готовым решением, а не своей арифметикой.
   *
   * `offset(8)` — зазор из §4; `flip()` перекидывает меню вверх, когда снизу
   * не помещается (на телефоне панель прижата к клавиатуре, и вниз места нет
   * вовсе); `shift()` прижимает к вьюпорту, чтобы крайняя кнопка не увела
   * меню за кромку; `autoUpdate` пересчитывает при прокрутке и resize.
   * Порядок middleware обязателен именно такой.
   */
  /*
   * Якорь у каретки — виртуальным элементом Floating UI: у него нет узла в
   * DOM, только прямоугольник. Считается один раз на открытие: пока меню
   * открыто, курсор не двигается, а пересчёт на каждый рендер гонял бы
   * позицию туда-сюда.
   *
   * Функция-источник держится в ref, потому что приходит инлайновой стрелкой
   * и была бы новой на каждом рендере — в зависимостях эффекта это дало бы
   * бесконечный цикл.
   */
  const [caretAnchor, setCaretAnchor] = useState<{ getBoundingClientRect: () => DOMRect } | null>(
    null,
  );
  const anchorSource = useRef(anchorToCaret);
  anchorSource.current = anchorToCaret;
  useEffect(() => {
    const make = anchorSource.current;
    if (!expanded || !make) {
      setCaretAnchor(null);
      return;
    }
    const rect = make();
    setCaretAnchor(rect ? { getBoundingClientRect: () => rect } : null);
  }, [expanded]);

  const { refs, floatingStyles, placement } = useFloating({
    placement: menuPlacement,
    strategy: 'fixed',
    /* Заданный `elements.reference` побеждает `refs.setReference` — так меню
       и переезжает с кнопки на каретку, не теряя ссылку на саму кнопку. */
    ...(caretAnchor ? { elements: { reference: caretAnchor } } : {}),
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8, limiter: limitShift() }),
      /* Высота — по РЕАЛЬНОМУ просвету, а не по доле экрана.
         Стоит после `flip()` и с тем же `padding`: тогда сначала выбирается
         сторона, а потом меню сжимается под то, что там осталось. С `80vh`,
         которое стояло тут раньше, на телефоне выходила ложь: панель прижата
         к клавиатуре, вверх остаётся куда меньше восьмидесяти процентов. */
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.setProperty(
            '--zp-menu-max',
            `${Math.max(120, availableHeight)}px`,
          );
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  return (
    <span className="zp-panel__anchor">
      <button
        type="button"
        ref={refs.setReference}
        /* Кнопка подсвечена, пока её меню открыто (§4, правило 2), и пока
           курсор стоит внутри того, что она применяет (§4, «Поведение»). */
        className={`zp-panel__btn${expanded || active ? ' zp-panel__btn--active' : ''}`}
        aria-pressed={active ?? undefined}
        aria-label={label}
        title={label}
        aria-expanded={expanded}
        aria-haspopup="menu"
        /* Один поток на мышь, перо и палец. Прежняя пара `mouse*` + `touch*`
           давала на касании ДВА `onPress` — меню открывалось и тут же
           закрывалось само, — потому что `preventDefault` в пассивном
           `touchstart` не подавляет совместимостные события мыши. */
        onPointerDown={(event) => {
          event.preventDefault();
          start();
        }}
        onPointerUp={() => {
          if (finish()) onPress();
        }}
        /* Палец уехал с кнопки — отменяем и долгое нажатие, и обычное.
           `pointercancel` присылает система, когда жест перехватила прокрутка. */
        onPointerLeave={() => finish()}
        onPointerCancel={() => {
          consumed.current = true;
          finish();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onLongPress?.();
        }}
      >
        {children}
      </button>
      {menu !== null && menu !== undefined && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={refs.setFloating}
              className="zp-panel__layer"
              data-side={placement.startsWith('top') ? 'top' : 'bottom'}
              style={floatingStyles}
            >
              {menu}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/** Подпись раздела внутри меню: 11 caps, третичным (§4). */

/** Ряд выравнивания — шесть кнопок §4 свёрнуты до трёх: вертикального
    выравнивания у markdown-таблицы нет, и обещать его нельзя. */
function Menu({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="zp-panel__menu" role="menu">
      {children}
    </div>
  );
}

/**
 * Диалог ссылки: «Текст» и «Адрес» (§4).
 *
 * Прежняя кнопка вставляла `[текст]()` и ставила курсор внутрь скобок —
 * работает, но требует знать разметку: человек видит две пары скобок и должен
 * догадаться, что адрес идёт во вторую.
 *
 * Поля заполняются из состояния РАЗ, при открытии: пока диалог открыт, курсор
 * в тексте не двигается, а перечитывание на каждый ввод затирало бы
 * набранное. Диапазон замены запомнен там же — по нему вставка и попадает
 * туда, откуда её позвали.
 */
/**
 * Прямоугольник каретки в координатах окна.
 *
 * `coordsAtPos` отдаёт координаты видимой позиции в документе; если каретки
 * нет (представление разрушено, позиция вне вьюпорта) — `null`, и тогда
 * привязка к курсору просто не включается.
 */
function caretRect(view: EditorView | null): DOMRect | null {
  if (!view) return null;
  const at = view.coordsAtPos(view.state.selection.main.head);
  if (!at) return null;
  return new DOMRect(at.left, at.top, 0, at.bottom - at.top);
}

function LinkDialog({
  copy,
  view,
  onClose,
}: {
  copy: EditorStrings['panel'];
  view: EditorView;
  onClose: () => void;
}): ReactElement {
  const draft = useRef(linkDraft(view.state));
  const [text, setText] = useState(draft.current.text);
  const [url, setUrl] = useState(draft.current.url);
  const first = useRef<HTMLInputElement>(null);

  /* Фокус в поле — иначе с клавиатуры до диалога не добраться, а на телефоне
     не поднимется клавиатура. В пустой «Текст», а при правке готовой ссылки
     — сразу в «Адрес»: подпись у неё уже есть. */
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);

  const submit = (): void => {
    view.dispatch(applyLink(draft.current, text, url));
    onClose();
  };

  return (
    <div
      className="zp-panel__menu zp-panel__menu--link"
      role="dialog"
      aria-label={copy.link}
      /* Клик внутри диалога не должен уводить фокус из полей: панель гасит
         `mousedown` целиком, а полю он нужен, чтобы поставить каретку. */
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="zp-panel__field">
        <label htmlFor="zp-link-text">{copy.linkText}</label>
        <input
          id="zp-link-text"
          ref={draft.current.editing ? null : first}
          className="zp-panel__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <div className="zp-panel__field">
        <label htmlFor="zp-link-url">{copy.linkUrl}</label>
        <input
          id="zp-link-url"
          ref={draft.current.editing ? first : null}
          className="zp-panel__input"
          inputMode="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="zp-panel__actions">
        <button type="button" className="zp-panel__action" onClick={onClose}>
          {copy.cancel}
        </button>
        <button
          type="button"
          className="zp-panel__action zp-panel__action--primary"
          onClick={submit}
        >
          {copy.insert}
        </button>
      </div>
    </div>
  );
}

interface MenuItemProps {
  label: string;
  onPress: () => void;
  /** Глиф 18 слева (§4). Без него строка меню — голый список. */
  glyph?: MenuGlyphName;
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
  /** Удаление — последним пунктом и своим цветом (§4). */
  danger?: boolean;
}

function MenuItem({
  label,
  onPress,
  glyph,
  checked,
  hotkey,
  submenu,
  back,
  separated,
  sample,
  index,
  danger,
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
        danger ? 'zp-panel__item--danger' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onPointerDown={(event) => {
        event.preventDefault();
        onPress();
      }}
    >
      {back ? <span className="zp-panel__chevron">←</span> : null}
      {index ? <span className="zp-panel__index">{index}</span> : null}
      {glyph ? <MenuGlyph name={glyph} /> : null}
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

/* ── Глифы строк меню: 18, stroke 1.6 ─────────────────────────────────────
   §4 дословно: «Строка меню: иконка 18 + название + хоткей моно 11 справа».
   Иконок не было вовсе, и меню читалось голым списком — одна из причин, по
   которой панель «выглядит не как в ТЗ». Набор нарочно скупой: по одному
   узнаваемому знаку на пункт, тем же языком, что и кнопки панели. */
const MENU_ICON = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Что нарисовать в строке меню. Ключ — смысл пункта, а не форма знака. */
export type MenuGlyphName =
  | 'heading'
  | 'text'
  | 'quote'
  | 'callout'
  | 'code'
  | 'small'
  | 'divider'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'highlight'
  | 'mono'
  | 'listNone'
  | 'listBullet'
  | 'listOrdered'
  | 'listTask'
  | 'listDetails'
  | 'image'
  | 'file'
  | 'audio'
  | 'rowAbove'
  | 'rowBelow'
  | 'colLeft'
  | 'colRight'
  | 'header'
  | 'remove';

const GLYPH: Record<MenuGlyphName, string[]> = {
  heading: ['M6 5v14M14 5v14M6 12h8', 'M18 9v10'],
  text: ['M5 7h14M5 12h11M5 17h13'],
  quote: ['M5 5v14', 'M10 9h9M10 14h6'],
  callout: ['M4 6h16v12H4z', 'M8 10h8M8 14h5'],
  code: ['M9 8l-4 4 4 4M15 8l4 4-4 4'],
  small: ['M8 9h9M8 14h6'],
  divider: ['M4 12h16'],
  bold: ['M8 5h5a3.5 3.5 0 010 7H8zM8 12h6a3.5 3.5 0 010 7H8z'],
  italic: ['M10 5h7M7 19h7M14 5l-4 14'],
  strike: ['M7 12h10', 'M8 7h8M8 17h8'],
  highlight: ['M5 16h14v3H5z', 'M8 13l4-8 4 8'],
  mono: ['M4 6h16v12H4z', 'M9 10l-2 2 2 2M15 10l2 2-2 2'],
  listNone: ['M7 7h12M7 12h12M7 17h12'],
  listBullet: ['M9 7h10M9 12h10M9 17h10', 'M5 7h.01M5 12h.01M5 17h.01'],
  listOrdered: ['M9 7h10M9 12h10M9 17h10', 'M4 6l1-.5V9M4 12h2l-2 3h2M4 16h2v2H4v2h2'],
  listTask: ['M9 7h10M9 17h10', 'M4 5h4v4H4z', 'M4.5 14.5l1.5 1.5L9 13'],
  listDetails: ['M6 8l4 4-4 4', 'M13 12h6M13 7h6'],
  image: ['M4 5h16v14H4z', 'M8 11a1.4 1.4 0 100-2.8 1.4 1.4 0 000 2.8', 'M4 16l5-4 4 3 3-2 4 3'],
  file: ['M14 4H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V9z', 'M14 4v5h5'],
  audio: ['M12 4v12', 'M9 8v4M15 8v4', 'M8 19h8'],
  rowAbove: ['M4 12h16M4 17h16', 'M12 4v5M9.5 6.5L12 4l2.5 2.5'],
  rowBelow: ['M4 7h16M4 12h16', 'M12 20v-5M9.5 17.5L12 20l2.5-2.5'],
  colLeft: ['M12 4v16M17 4v16', 'M4 12h5M6.5 9.5L4 12l2.5 2.5'],
  colRight: ['M7 4v16M12 4v16', 'M20 12h-5M17.5 9.5L20 12l-2.5 2.5'],
  header: ['M4 5h16v5H4z', 'M4 10v9M20 10v9M4 19h16', 'M12 10v9'],
  remove: ['M6 8h12', 'M9 8V5h6v3', 'M8 8l1 12h6l1-12'],
};

function MenuGlyph({ name }: { name: MenuGlyphName }): ReactElement {
  return (
    <svg {...MENU_ICON} className="zp-panel__glyph">
      {GLYPH[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
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
