/**
 * Редактор таблицы — виджет по образцу диалога ссылки (ITERATION-1 §4).
 *
 * Заказчик: «таблица капут при вводе; для редактирования таблицы используем
 * виджет, по аналогии с добавлением ссылки. У этого виджета должны быть
 * инструменты: перетаскивание строки/столбца, выравнивание, добавление
 * строки/столбца».
 *
 * Почему виджет, а не меню. Меню правки таблица уже имела, и оно работало —
 * но правило в нём было одно: «сделать что-то с той ячейкой, где стоит
 * курсор». Чтобы переставить вторую строку под четвёртую, надо было держать
 * в голове, где именно каретка, а на телефоне её ещё и не видно за
 * клавиатурой. Здесь таблица показана целиком и правится там же, где видна:
 * ячейку правит поле, строку и столбец переносит ручка, выравнивание стоит
 * рядом с колонкой, к которой относится.
 *
 * Про вертикальное выравнивание, которое просили наравне с горизонтальным:
 * в markdown его нет. Строка-разделитель кодирует ровно три состояния —
 * `:---`, `:---:`, `---:`. Рисовать три кнопки, которые ничего не делают,
 * значит врать; поэтому вместо них строка текста, объясняющая, почему их
 * нет. Сделать вертикальное выравнивание можно было бы только html-таблицей,
 * а это перестало бы быть markdown — правило «file over app» этого не
 * позволяет.
 *
 * Источник правды — ДОКУМЕНТ, но черновик держится отдельно. Причина
 * приземлённая: в файле ячейка хранится обрезанной с краёв, поэтому пробел,
 * набранный между словами последним, из документа возвращался бы съеденным,
 * и «Бумага А4» набрать было бы нельзя. Черновик хранит текст как набрали, а
 * в документ уходит канонический вид.
 */
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';

import type { EditorStrings } from '../i18n.js';
import { IconAlign } from './icons.js';
import {
  alignColumn,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  setCell,
  tableAt,
  tableChange,
  toggleHeader,
} from '../commands/table.js';
import type { ColumnAlign, TableModel } from '../commands/table.js';

export interface TableDialogProps {
  copy: EditorStrings['panel'];
  view: EditorView;
  /** Тост «Отменить» на удаление строки и столбца (§4). */
  onUndoable?: (message: string, undo: () => void) => void;
  onClose: () => void;
}

/** Что сейчас тащат: строку или столбец, и какую именно. */
interface Drag {
  kind: 'row' | 'column';
  index: number;
}

export function TableDialog({ copy, view, onUndoable, onClose }: TableDialogProps): ReactElement | null {
  const initial = useRef<TableModel | null>(tableAt(view.state));
  /* Номер первой строки таблицы: по нему она находится в документе после
     каждой перезаписи. Пока диалог открыт, текст выше не меняется. */
  const anchor = useRef(initial.current?.firstLine ?? 1);
  const [draft, setDraft] = useState<TableModel | null>(initial.current);
  const [column, setColumn] = useState(initial.current?.column ?? 0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const rowNodes = useRef<(HTMLElement | null)[]>([]);
  const columnNodes = useRef<(HTMLElement | null)[]>([]);

  if (!draft) return null;
  const width = draft.rows[0]?.length ?? 0;
  const strings = copy.tableMenu;

  /** Записать черновик в документ. Таблица переписывается целиком. */
  const write = (next: TableModel | null, userEvent = 'input.format'): void => {
    if (!next) return;
    setDraft(next);
    const doc = view.state.doc;
    if (anchor.current > doc.lines) return;
    const current = tableAt(view.state, doc.line(anchor.current).from + 1);
    if (!current) return;
    view.dispatch({ changes: tableChange(view.state, current, next), userEvent });
  };

  /**
   * Удаление с тостом «Отменить» (§4).
   *
   * Отменяет обычная отмена редактора: удаление — одна транзакция. Черновик
   * после отмены перечитывается из документа — иначе диалог продолжил бы
   * показывать таблицу без строки, которую только что вернули.
   */
  const removeWithUndo = (next: TableModel | null, message: string): void => {
    if (!next) return;
    write(next);
    onUndoable?.(message, () => {
      undo(view);
      const doc = view.state.doc;
      if (anchor.current > doc.lines) return;
      const model = tableAt(view.state, doc.line(anchor.current).from + 1);
      if (model) setDraft(model);
    });
  };

  // ── Перетаскивание ────────────────────────────────────────────────────────

  /**
   * Куда попал указатель. Считается по настоящим прямоугольникам строк и
   * колонок, а не по арифметике «высота × номер»: ячейки разной ширины, и
   * арифметика промахивалась бы ровно там, где перетаскивание и нужно.
   */
  const targetAt = (kind: 'row' | 'column', x: number, y: number): number | null => {
    const nodes = kind === 'row' ? rowNodes.current : columnNodes.current;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node) continue;
      const box = node.getBoundingClientRect();
      const inside = kind === 'row' ? y >= box.top && y <= box.bottom : x >= box.left && x <= box.right;
      if (inside) return index;
    }
    return null;
  };

  const onDragMove = (event: ReactPointerEvent): void => {
    if (!drag) return;
    const target = targetAt(drag.kind, event.clientX, event.clientY);
    if (target === null || target === drag.index) return;
    /* Строки и столбцы переставляются ЖИВЬЁМ, пока палец не отпустили: так
       видно результат, и не нужна отдельная линия-указатель, которую на
       телефоне всё равно закрывает палец. В документ уходит только итог. */
    const next =
      drag.kind === 'row' ? moveRow(draft, drag.index, target) : moveColumn(draft, drag.index, target);
    if (!next) return;
    setDraft(next);
    if (drag.kind === 'column') setColumn(target);
    setDrag({ ...drag, index: target });
  };

  const endDrag = (): void => {
    if (!drag) return;
    setDrag(null);
    write(draft);
  };

  const startDrag = (kind: 'row' | 'column', index: number) => (event: ReactPointerEvent) => {
    /* Ручка не должна уводить фокус из поля ячейки и не должна прокручивать
       страницу: `touch-action: none` в стилях и `preventDefault` здесь. */
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setDrag({ kind, index });
  };

  // ── Разметка ──────────────────────────────────────────────────────────────

  const dragging = (kind: 'row' | 'column', index: number): string =>
    drag?.kind === kind && drag.index === index ? ' zp-table__handle--on' : '';

  return (
    <div
      className="zp-panel__menu zp-table"
      role="dialog"
      aria-label={strings.title}
      /* Нажатие внутри диалога не уводит фокус из полей: панель гасит
         `mousedown` целиком, а полю он нужен, чтобы поставить каретку. */
      onMouseDown={(event) => event.stopPropagation()}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="zp-table__grid" style={{ gridTemplateColumns: `24px repeat(${width}, 1fr) 28px` }}>
        {/* Ряд ручек столбцов. */}
        <span />
        {draft.rows[0]?.map((_cell, index) => (
          <button
            key={`col-${index}`}
            type="button"
            ref={(node) => {
              columnNodes.current[index] = node;
            }}
            className={`zp-table__handle zp-table__handle--col${dragging('column', index)}${
              column === index ? ' zp-table__handle--sel' : ''
            }`}
            aria-label={`${strings.dragColumn} ${index + 1}`}
            title={strings.dragColumn}
            onPointerDown={startDrag('column', index)}
            onClick={() => setColumn(index)}
          >
            <Grip horizontal />
          </button>
        ))}
        <span />

        {/* Строки: ручка, ячейки, удаление. */}
        {draft.rows.map((cells, row) => {
          const locked = draft.header && row === 0;
          return (
            <Row key={`row-${row}`}>
              <button
                type="button"
                ref={(node) => {
                  rowNodes.current[row] = node;
                }}
                className={`zp-table__handle${dragging('row', row)}`}
                aria-label={`${strings.dragRow} ${row + 1}`}
                title={locked ? strings.headerRow : strings.dragRow}
                disabled={locked}
                onPointerDown={locked ? undefined : startDrag('row', row)}
              >
                <Grip />
              </button>
              {cells.map((cell, index) => (
                <input
                  key={`cell-${row}-${index}`}
                  className={`zp-table__cell${draft.header && row === 0 ? ' zp-table__cell--head' : ''}`}
                  style={{ textAlign: cssAlign(draft.aligns[index] ?? 'none') }}
                  value={cell}
                  aria-label={`${strings.columnNumber(index + 1)}, ${row + 1}`}
                  onFocus={() => setColumn(index)}
                  onChange={(event) => write(setCell(draft, row, index, event.target.value), 'input.type')}
                />
              ))}
              <button
                type="button"
                className="zp-table__drop"
                aria-label={strings.removeRow}
                title={strings.removeRow}
                onClick={() => removeWithUndo(removeRow({ ...draft, row }), strings.rowRemoved)}
              >
                <Cross />
              </button>
            </Row>
          );
        })}
      </div>

      <div className="zp-table__adds">
        <button
          type="button"
          className="zp-table__add"
          onClick={() => write(insertRow({ ...draft, row: draft.rows.length - 1 }, 'below'))}
        >
          <Plus /> {strings.addRow}
        </button>
        <button
          type="button"
          className="zp-table__add"
          onClick={() => write(insertColumn({ ...draft, column }, 'right'))}
        >
          <Plus /> {strings.addColumn}
        </button>
      </div>

      <div className="zp-table__section">
        <div className="zp-table__label">{strings.columnNumber(column + 1)}</div>
        <div className="zp-panel__aligns">
          {(['left', 'center', 'right'] as const).map((align) => (
            <button
              key={align}
              type="button"
              aria-label={strings.aligns[align]}
              title={strings.aligns[align]}
              aria-pressed={draft.aligns[column] === align}
              className={`zp-panel__align${
                draft.aligns[column] === align ? ' zp-panel__align--on' : ''
              }`}
              onClick={() => write(alignColumn({ ...draft, column }, align))}
            >
              <IconAlign side={align} size={17} />
            </button>
          ))}
          <button
            type="button"
            className="zp-panel__align zp-table__danger"
            aria-label={strings.removeColumn}
            title={strings.removeColumn}
            onClick={() =>
              removeWithUndo(removeColumn({ ...draft, column }), strings.columnRemoved)
            }
          >
            <Cross />
          </button>
        </div>
        {/* Прямо о том, чего markdown не умеет, — вместо мёртвых кнопок. */}
        <div className="zp-table__note">{strings.noVertical}</div>
      </div>

      <div className="zp-table__foot">
        <label className="zp-table__check">
          <input
            type="checkbox"
            checked={draft.header}
            onChange={() => write(toggleHeader(draft))}
          />
          {strings.headerRow}
        </label>
        <button
          type="button"
          className="zp-panel__action zp-panel__action--primary"
          onClick={() => {
            onClose();
            view.focus();
          }}
        >
          {copy.done}
        </button>
      </div>
    </div>
  );
}

/** Строка сетки: фрагмент, чтобы ячейки лежали в общей сетке, а не в своей. */
function Row({ children }: { children: ReactNode }): ReactElement {
  return <>{children}</>;
}

function cssAlign(align: ColumnAlign): 'left' | 'center' | 'right' {
  if (align === 'center') return 'center';
  if (align === 'right') return 'right';
  return 'left';
}

/** Ручка: две колонки точек — знак «меня можно тащить», понятный без подписи. */
function Grip({ horizontal = false }: { horizontal?: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      {(horizontal ? [2, 6, 10] : [3, 9]).flatMap((first) =>
        (horizontal ? [4, 8] : [2, 6, 10]).map((second) => (
          <circle
            key={`${first}-${second}`}
            cx={horizontal ? first : first}
            cy={horizontal ? second : second}
            r="1"
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}

function Cross(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function Plus(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Стили редактора: живут в общем модуле панели, чтобы тень и радиусы совпадали. */
export const tableDialogStyles = {
  '.zp-table': { display: 'grid', gap: '10px', padding: '10px', minWidth: '280px' },
  '.zp-table__grid': {
    display: 'grid',
    gap: '4px',
    alignItems: 'center',
    /* Много колонок не должны распирать панель шире экрана: сетка едет вбок
       сама, а панель остаётся на месте. */
    overflowX: 'auto',
    maxWidth: '72vw',
  },
  '.zp-table__handle': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: '24px',
    blockSize: '28px',
    padding: '0',
    border: '0',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    cursor: 'grab',
    touchAction: 'none',
  },
  '.zp-table__handle--col': { blockSize: '18px', inlineSize: '100%' },
  '.zp-table__handle--sel': { color: 'var(--accent)' },
  '.zp-table__handle--on': { backgroundColor: 'var(--accent-soft)', color: 'var(--accent)', cursor: 'grabbing' },
  '.zp-table__handle:disabled': { opacity: '0.35', cursor: 'default' },
  '.zp-table__cell': {
    minWidth: '64px',
    height: '30px',
    padding: '0 6px',
    borderRadius: '6px',
    border: '1px solid var(--line)',
    backgroundColor: 'var(--surface-sunken)',
    color: 'var(--text)',
    font: 'inherit',
    fontSize: '13px',
  },
  '.zp-table__cell--head': { fontWeight: '600' },
  '.zp-table__cell:focus-visible': {
    outline: '2px solid var(--focus-ring, var(--accent))',
    outlineOffset: '1px',
  },
  '.zp-table__drop': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    inlineSize: '28px',
    blockSize: '28px',
    padding: '0',
    border: '0',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
  },
  '.zp-table__drop:hover': { color: 'var(--danger, var(--text))' },
  '.zp-table__adds': { display: 'flex', gap: '6px' },
  '.zp-table__add': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    height: '30px',
    padding: '0 10px',
    borderRadius: '8px',
    border: '1px dashed var(--line)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    font: 'inherit',
    fontSize: '13px',
    cursor: 'pointer',
  },
  '.zp-table__section': { borderTop: '1px solid var(--line)', paddingTop: '8px' },
  '.zp-table__label': {
    padding: '0 6px 2px',
    fontSize: '11px',
    letterSpacing: '.04em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
  },
  '.zp-table__note': { padding: '2px 6px 0', fontSize: '11px', color: 'var(--text-tertiary)' },
  '.zp-table__danger:hover': { color: 'var(--danger, var(--text))' },
  '.zp-table__foot': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    borderTop: '1px solid var(--line)',
    paddingTop: '8px',
  },
  '.zp-table__check': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  /* Иначе галочка системно-синяя — единственное синее пятно во всём окне. */
  '.zp-table__check input': { accentColor: 'var(--accent)' },
};
