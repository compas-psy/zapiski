/**
 * Правка таблиц (ITERATION-1 §4, «Таблица — ручки строк и столбцов»).
 *
 * Цитата из спецификации: «Это самая недооценённая часть, без неё таблица
 * нередактируема на телефоне». Так и есть — markdown-таблица держится на
 * выравнивании палок `|`, и вставить столбец руками означает поправить каждую
 * строку, не сбившись. На телефоне это нереально.
 *
 * Здесь — модель и команды: разбор таблицы под курсором, вставка и удаление
 * строк и столбцов, выравнивание, строка заголовка. Всё возвращает готовый
 * текст блока, поэтому проверяется без DOM и без представления.
 *
 * Таблица переписывается ЦЕЛИКОМ на каждое действие. Это дороже точечной
 * правки, но единственный способ удержать её ровной: ширина колонки зависит от
 * самой длинной ячейки, и после вставки одного слова разъезжаются все строки.
 * Кривая таблица остаётся валидным markdown, но читать её в чужом редакторе
 * невозможно — а файл обязан оставаться человеческим (file over app).
 */
import type { ChangeSpec, EditorState } from '@codemirror/state';
import type { Command } from '@codemirror/view';

/** Выравнивание колонки, как его кодирует строка-разделитель. */
export type ColumnAlign = 'none' | 'left' | 'center' | 'right';

export interface TableModel {
  /** Номер первой строки таблицы в документе (с единицы). */
  firstLine: number;
  lastLine: number;
  /** Ячейки построчно, БЕЗ строки-разделителя. Первая строка — шапка. */
  rows: string[][];
  aligns: ColumnAlign[];
  /** Есть ли строка-разделитель: без неё это не таблица, а просто палки. */
  header: boolean;
  /** Строка курсора внутри `rows` и колонка — куда применять действие. */
  row: number;
  column: number;
}

/** Строка таблицы: начинается и заканчивается палкой, между ними — ячейки. */
export const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** Разделитель шапки: `| --- | :-: |`. */
export const TABLE_DIVIDER = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

/** Ячейка вместе с её местом в строке — смещения от начала строки. */
export interface CellSpan {
  /** Текст ячейки без окружающих пробелов. */
  text: string;
  /** Начало текста ячейки в строке. */
  from: number;
  /** Конец текста ячейки в строке. */
  to: number;
}

/**
 * Разбирает строку в ячейки, снимая крайние палки, и запоминает их место.
 *
 * Экранированная палка `\|` — часть текста, а не граница ячейки: так её
 * понимает GFM, и так её пишет редактор таблицы, когда палку набирают внутри
 * ячейки. Обычный `split('|')` разорвал бы такую ячейку надвое, и таблица
 * молча получала бы лишний столбец.
 *
 * Смещения нужны показу: нарисованную таблицу правят, ткнув в ячейку, и
 * попасть курсор обязан ровно в ту ячейку, куда ткнули. Считать их отдельным
 * разбором значило бы завести второе место, где толкуется `\|`, — а два таких
 * места однажды разойдутся.
 */
export function cellSpans(line: string): CellSpan[] {
  const first = line.indexOf('|');
  if (first < 0) return [];
  /* Строка без закрывающей палки — всё до конца строки одна ячейка: так же
     её понимал прежний разбор, и терять на этом столбец не за что. */
  const last = line.lastIndexOf('|');
  const end = last > first ? last : line.length;

  const out: CellSpan[] = [];
  let start = first + 1;
  const push = (stop: number): void => {
    let from = start;
    let to = stop;
    while (from < to && (line[from] as string).trim() === '') from += 1;
    while (to > from && (line[to - 1] as string).trim() === '') to -= 1;
    out.push({ text: line.slice(from, to), from, to });
  };

  let index = start;
  while (index < end) {
    const char = line[index] as string;
    if (char === '\\' && line[index + 1] === '|') {
      index += 2;
      continue;
    }
    if (char === '|') {
      push(index);
      start = index + 1;
    }
    index += 1;
  }
  push(end);
  return out;
}

/** Только тексты ячеек — большей части кода правки таблицы места не нужны. */
function cells(line: string): string[] {
  return cellSpans(line).map((cell) => cell.text);
}

/** Выравнивание колонки по её куску строки-разделителя: `:-:`, `--:`, `:--`. */
export function alignOf(spec: string): ColumnAlign {
  const value = spec.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return 'none';
}

function alignSpec(align: ColumnAlign, width: number): string {
  const dashes = Math.max(3, width);
  if (align === 'center') return `:${'-'.repeat(Math.max(1, dashes - 2))}:`;
  if (align === 'right') return `${'-'.repeat(Math.max(2, dashes - 1))}:`;
  if (align === 'left') return `:${'-'.repeat(Math.max(2, dashes - 1))}`;
  return '-'.repeat(dashes);
}

/**
 * Таблица, внутри которой стоит курсор. `null` — курсор не в таблице.
 *
 * Границами служат строки, не похожие на строку таблицы: пустая строка, абзац,
 * заголовок. Так соседние таблицы через абзац не сливаются в одну.
 */
export function tableAt(state: EditorState, pos = state.selection.main.head): TableModel | null {
  const doc = state.doc;
  const cursorLine = doc.lineAt(pos);
  if (!TABLE_ROW.test(cursorLine.text)) return null;

  let first = cursorLine.number;
  while (first > 1 && TABLE_ROW.test(doc.line(first - 1).text)) first -= 1;
  let last = cursorLine.number;
  while (last < doc.lines && TABLE_ROW.test(doc.line(last + 1).text)) last += 1;

  const lines: string[] = [];
  for (let n = first; n <= last; n += 1) lines.push(doc.line(n).text);

  /* Разделитель — всегда вторая строка: markdown другого места ему не даёт. */
  const header = lines.length >= 2 && TABLE_DIVIDER.test(lines[1] as string);
  const aligns = header ? cells(lines[1] as string).map(alignOf) : [];
  const rows = lines.filter((_line, index) => !(header && index === 1)).map(cells);
  if (rows.length === 0) return null;

  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
  const paddedAligns: ColumnAlign[] = Array.from(
    { length: width },
    (_value, index) => aligns[index] ?? 'none',
  );

  /* Строка курсора в координатах `rows`: разделитель из них выброшен. */
  const offset = header && cursorLine.number > first + 1 ? 1 : 0;
  const row = Math.max(0, cursorLine.number - first - offset);
  return {
    firstLine: first,
    lastLine: last,
    rows: padded,
    aligns: paddedAligns,
    header,
    row: Math.min(row, padded.length - 1),
    column: columnAt(cursorLine.text, pos - cursorLine.from),
  };
}

/**
 * Enter внутри строки таблицы — не переводит строку (P1-аудит).
 *
 * Обычный перевод строки посреди `| 1 | 2 |` разрубает саму строку: половина
 * остаётся на своём месте, вторая половина больше не начинается с `|` и
 * выпадает из TABLE_ROW насовсем — тихая потеря данных, без диалога и без
 * визуальной тревоги. То же самое, только внутри таблицы, а не внутри
 * строки, происходит и на конце НЕпоследней строки: пустая строка между
 * строками таблицы рвёт один блок на два.
 *
 * Правка ячеек в этом продукте и так идёт через `TableDialog` (Tab внутри
 * таблицы по той же причине умышленно ничего не делает — см. `helpers.ts`),
 * поэтому Enter внутри уже начатой таблицы просто гасится, кроме одного
 * случая: курсор в конце ПОСЛЕДНЕЙ строки таблицы — это единственное место,
 * где обычный перевод строки ожидаемо создаёт абзац ПОСЛЕ таблицы, и его
 * трогать не нужно.
 */
export const tableEnter: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const model = tableAt(view.state, range.head);
  if (!model) return false;
  const line = view.state.doc.lineAt(range.head);
  const atEndOfLastLine = line.number === model.lastLine && range.head === line.to;
  if (atEndOfLastLine) return false;
  return true;
};

/** В какой ячейке стоит курсор — считаем палки левее него. */
function columnAt(line: string, offset: number): number {
  const before = line.slice(0, offset);
  const bars = (before.match(/\|/g) ?? []).length;
  return Math.max(0, bars - 1);
}

/**
 * Собирает таблицу обратно, выравнивая колонки по самой длинной ячейке.
 *
 * Ширина считается в кодовых точках, а не в байтах: кириллица иначе получила
 * бы вдвое больше места, чем занимает.
 */
export function renderTable(model: Pick<TableModel, 'rows' | 'aligns' | 'header'>): string {
  const width = Math.max(...model.rows.map((row) => row.length));
  const widths = Array.from({ length: width }, (_value, index) =>
    Math.max(3, ...model.rows.map((row) => [...(row[index] ?? '')].length)),
  );

  const line = (row: string[]): string =>
    `| ${widths.map((size, index) => pad(row[index] ?? '', size)).join(' | ')} |`;

  const out = [line(model.rows[0] ?? [])];
  if (model.header) {
    out.push(
      `| ${widths
        .map((size, index) => alignSpec(model.aligns[index] ?? 'none', size))
        .join(' | ')} |`,
    );
  }
  for (const row of model.rows.slice(1)) out.push(line(row));
  return out.join('\n');
}

function pad(text: string, size: number): string {
  const length = [...text].length;
  return length >= size ? text : text + ' '.repeat(size - length);
}

/** Изменение документа, переписывающее таблицу целиком. */
function rewrite(state: EditorState, model: TableModel, next: Omit<TableModel, keyof TableModel> | TableModel): ChangeSpec {
  return {
    from: state.doc.line(model.firstLine).from,
    to: state.doc.line(model.lastLine).to,
    insert: renderTable(next as TableModel),
  };
}

// ── Действия над строками ───────────────────────────────────────────────────

export function insertRow(model: TableModel, where: 'above' | 'below'): TableModel {
  const empty = Array.from({ length: model.rows[0]?.length ?? 0 }, () => '');
  const rows = [...model.rows];
  /* Выше первой строки при наличии шапки вставлять нельзя: там разделитель, и
     новая строка стала бы заголовком, потеряв прежний. */
  const at = model.header && model.row === 0 && where === 'above' ? 1 : model.row + (where === 'below' ? 1 : 0);
  rows.splice(at, 0, empty);
  return { ...model, rows };
}

export function removeRow(model: TableModel): TableModel | null {
  /* Шапку не удаляем: без неё таблица распадается на строки с палками. */
  if (model.header && model.row === 0) return null;
  if (model.rows.length <= 1) return null;
  const rows = model.rows.filter((_row, index) => index !== model.row);
  return { ...model, rows };
}

// ── Действия над столбцами ──────────────────────────────────────────────────

export function insertColumn(model: TableModel, where: 'left' | 'right'): TableModel {
  const at = model.column + (where === 'right' ? 1 : 0);
  const rows = model.rows.map((row) => {
    const next = [...row];
    next.splice(at, 0, '');
    return next;
  });
  const aligns = [...model.aligns];
  aligns.splice(at, 0, 'none');
  return { ...model, rows, aligns };
}

export function removeColumn(model: TableModel): TableModel | null {
  if ((model.rows[0]?.length ?? 0) <= 1) return null;
  const rows = model.rows.map((row) => row.filter((_cell, index) => index !== model.column));
  const aligns = model.aligns.filter((_align, index) => index !== model.column);
  return { ...model, rows, aligns };
}

// ── Перестановка перетаскиванием ────────────────────────────────────────────

/**
 * Переставить строку. `to` — место В ИСХОДНОЙ нумерации, куда её кладут.
 *
 * Шапка остаётся шапкой: её не уносят и на её место не кладут. Это не
 * придирка к порядку, а разметка — первая строка таблицы и есть заголовок,
 * и перестановка сделала бы заголовком чужие данные.
 */
export function moveRow(model: TableModel, from: number, to: number): TableModel | null {
  const first = model.header ? 1 : 0;
  if (from < first || to < first) return null;
  if (from >= model.rows.length || to >= model.rows.length || from === to) return null;
  const rows = [...model.rows];
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved as string[]);
  return { ...model, rows, row: to };
}

/** Переставить столбец вместе с его выравниванием. */
export function moveColumn(model: TableModel, from: number, to: number): TableModel | null {
  const width = model.rows[0]?.length ?? 0;
  if (from < 0 || to < 0 || from >= width || to >= width || from === to) return null;
  const rows = model.rows.map((row) => {
    const next = [...row];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved ?? '');
    return next;
  });
  const aligns = [...model.aligns];
  const [movedAlign] = aligns.splice(from, 1);
  aligns.splice(to, 0, movedAlign ?? 'none');
  return { ...model, rows, aligns, column: to };
}

/** Правка одной ячейки: редактор таблицы правит содержимое, а не только каркас. */
export function setCell(model: TableModel, row: number, column: number, text: string): TableModel {
  const rows = model.rows.map((cells, index) =>
    index === row ? cells.map((cell, at) => (at === column ? sanitizeCell(text) : cell)) : cells,
  );
  return { ...model, rows };
}

/**
 * Что нельзя пускать в ячейку.
 *
 * Палка разорвала бы строку на две ячейки, перевод строки — на две строки:
 * человек напечатал бы обычный текст, а таблица развалилась бы молча. Палка
 * экранируется (так её понимает GFM), перевод строки становится пробелом.
 *
 * Края НЕ обрезаются, и это принципиально. Обрезка тут значила бы, что
 * пробел, набранный между двумя словами последним, исчезает ровно в момент
 * набора, — и «Бумага А4» напечатать было бы нельзя. В файл ячейка всё равно
 * ляжет ровной: ширину добивает `renderTable`, а при следующем разборе края
 * снимет `cells`.
 */
function sanitizeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
}

/** Выравнивание текущего столбца. Требует строки заголовка: она его и кодирует. */
export function alignColumn(model: TableModel, align: ColumnAlign): TableModel {
  const aligns = [...model.aligns];
  aligns[model.column] = align;
  return { ...model, aligns, header: true };
}

/** Строка заголовка: без неё markdown рисует таблицу без шапки. */
export function toggleHeader(model: TableModel): TableModel {
  return { ...model, header: !model.header };
}

/** Готовое изменение документа для любого из действий выше. */
export function tableChange(state: EditorState, model: TableModel, next: TableModel): ChangeSpec {
  return rewrite(state, model, next);
}
