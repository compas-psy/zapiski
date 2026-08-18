/**
 * Таблица показывается таблицей, а не палками.
 *
 * ── Отказ, ради которого написано ───────────────────────────────────────────
 *
 * Заказчик скопировал в ЗАПИСКИ обычный `.md` с хорошей разметкой и прислал
 * скриншот: «как коряво открылась таблица». Так и было, и причина не в одной
 * мелочи, а в самом способе показа.
 *
 * До сих пор таблица оставалась строками текста: палки прятались, а вместо них
 * ячейке рисовалась правая грань. Ровно это выглядит таблицей ровно в одном
 * случае — когда исходник ВЫРОВНЕН пробелами, то есть когда его писали мы
 * сами (`table-format.ts` добивает ячейки до общей ширины, когда курсор из
 * таблицы уходит). У чужого файла ничего этого нет:
 *
 *   · ячейки не добиты, поэтому грани стоят в разных местах каждой строки —
 *     колонок не видно вовсе;
 *   · в ячейке живёт целое предложение, строка переносится, и грань оказывается
 *     посреди абзаца;
 *   · моноширинный шрифт при этом делает строку ещё длиннее.
 *
 * Выровнять чужой файл при открытии было бы проще всего — и это худший выход:
 * заметка помечается изменённой, уезжает в облако и возвращается на второе
 * устройство «изменённой» без единой правки человека. Файл не наш, и трогать
 * его только ради вида нельзя (file over app).
 *
 * Поэтому здесь показ, а не правка: строки таблицы заменяются виджетом с
 * настоящим `<table>`. Колонки считает браузер, длинный текст переносится
 * ВНУТРИ ячейки, а в файле остаётся ровно то, что там лежало.
 *
 * ── Почему поле состояния, а не плагин представления ────────────────────────
 *
 * Документация CodeMirror про `EditorView.decorations`: набор, отданный
 * ФУНКЦИЕЙ (то есть плагином представления), считается уже после вычисления
 * вьюпорта и не имеет права вводить блочные виджеты и замены, накрывающие
 * переводы строк. Наша замена накрывает всю таблицу целиком — значит она
 * обязана приходить полем состояния, напрямую. Отсюда и разделение: живой
 * показ разметки живёт в `decorations.ts` (плагин, только видимые куски), а
 * таблица — здесь.
 *
 * ── Курсор ──────────────────────────────────────────────────────────────────
 *
 * Таблица под курсором не заменяется НИЧЕМ: там сырой markdown с палками, как
 * его и правят, — и работают ручки строк и столбцов. Границы считаются
 * прилегающими: курсор, вставший ровно на первую или последнюю позицию
 * таблицы, уже «внутри». Ради этого правила стрелка сверху и снизу входит в
 * таблицу, а не перескакивает её.
 *
 * Тычок в нарисованную ячейку ставит курсор в ту же ячейку исходника —
 * поэтому у каждой ячейки в DOM записано её смещение от начала таблицы.
 */
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { RangeSet, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range, Text, Transaction } from '@codemirror/state';

import { TABLE_DIVIDER, TABLE_ROW, alignOf, cellSpans } from '../commands/table.js';
import type { ColumnAlign } from '../commands/table.js';
import { inlineTokens } from './inline-text.js';
import type { InlineToken } from './inline-text.js';
import { isRawMode } from './raw-mode.js';

/** Границы таблицы в документе: от начала первой строки до конца последней. */
export interface TableSpan {
  from: number;
  to: number;
}

/**
 * Кусок документа, который нужно пересмотреть после правки.
 *
 * Строки — чтобы читать текст, позиции — чтобы сравнивать с таблицами без
 * единого обращения к дереву строк: в заметке на мегабайт таблиц тысячи, и
 * `lineAt` на каждую съел бы бюджет ввода целиком.
 */
interface Region {
  fromLine: number;
  toLine: number;
  from: number;
  to: number;
}

// ── Поиск таблиц в документе ────────────────────────────────────────────────

/**
 * Таблицей считается подряд идущий кусок строк с палками, у которого ВТОРАЯ
 * строка — разделитель `| --- | --- |`.
 *
 * Без разделителя GFM таблицы не видит, и мы её тоже не рисуем: иначе строка
 * «вариант А | вариант Б» превратилась бы в таблицу самоуправством, и в чужом
 * редакторе тот же файл выглядел бы иначе. Набранной руками таблице
 * разделитель дописывает `table-format.ts`, как только курсор из неё выйдет.
 */
function isTableRun(count: number, second: string): boolean {
  return count >= 2 && TABLE_DIVIDER.test(second);
}

/** Таблицы в строках [fromLine..toLine]. Строки берутся одним проходом. */
function scanLines(doc: Text, fromLine: number, toLine: number): TableSpan[] {
  const out: TableSpan[] = [];
  let pos = doc.line(fromLine).from;
  let runFrom = -1;
  let runCount = 0;
  let runSecond = '';

  for (const text of doc.iterLines(fromLine, toLine + 1)) {
    if (TABLE_ROW.test(text)) {
      if (runFrom < 0) {
        runFrom = pos;
        runCount = 0;
        runSecond = '';
      }
      runCount += 1;
      if (runCount === 2) runSecond = text;
    } else if (runFrom >= 0) {
      if (isTableRun(runCount, runSecond)) out.push({ from: runFrom, to: pos - 1 });
      runFrom = -1;
    }
    pos += text.length + 1;
  }
  if (runFrom >= 0 && isTableRun(runCount, runSecond)) out.push({ from: runFrom, to: pos - 1 });
  return out;
}

/**
 * Кусок по номерам строк, раздвинутый до целых таблиц.
 *
 * Без раздвигания правка в середине таблицы дала бы огрызок: пересмотренными
 * оказались бы три строки, а границы таблицы считаются по всему подряду
 * идущему куску строк с палками.
 */
function regionOf(doc: Text, fromLine: number, toLine: number): Region {
  let from = Math.max(1, fromLine);
  let to = Math.min(doc.lines, toLine);
  while (from > 1 && TABLE_ROW.test(doc.line(from - 1).text)) from -= 1;
  while (to < doc.lines && TABLE_ROW.test(doc.line(to + 1).text)) to += 1;
  return { fromLine: from, toLine: to, from: doc.line(from).from, to: doc.line(to).to };
}

/** Слить пересекающиеся и соседние куски: иначе строки сканируются дважды. */
function merge(regions: Region[]): Region[] {
  const sorted = [...regions].sort((a, b) => a.fromLine - b.fromLine);
  const out: Region[] = [];
  for (const region of sorted) {
    const last = out[out.length - 1];
    if (last && region.fromLine <= last.toLine + 1) {
      if (region.toLine > last.toLine) {
        last.toLine = region.toLine;
        last.to = region.to;
      }
    } else out.push({ ...region });
  }
  return out;
}

/** Попадает ли таблица хоть одним знаком в пересматриваемые куски. */
function inRegions(regions: readonly TableSpan[], span: TableSpan): boolean {
  for (const region of regions) {
    if (span.from <= region.to && span.to >= region.from) return true;
  }
  return false;
}

/** Все таблицы документа — этим начинается работа с заметкой. */
export function tableSpans(doc: Text): TableSpan[] {
  return doc.lines === 0 ? [] : scanLines(doc, 1, doc.lines);
}

/**
 * Таблицы после правки — пересматриваются ТОЛЬКО задетые куски.
 *
 * Полный проход по документу на каждое нажатие клавиши стоит бюджета ввода:
 * в заметке на мегабайт это пятьдесят тысяч строк, и перф-тест
 * (`test/perf.test.ts`, 16 мс на кейстрок) поймал бы такое сразу. Поэтому
 * старые границы сдвигаются вместе с текстом, а заново читается окрестность
 * правки — вместе с целыми таблицами, которых она коснулась.
 */
export function nextSpans(
  previous: TableSpan[],
  tr: Transaction,
): { spans: TableSpan[]; dirty: Region[] } {
  const doc = tr.state.doc;

  /*
   * Границы правки в СТАРЫХ координатах. Всё, что кончилось до них, не
   * сдвинулось вовсе; всё, что началось после, сдвинулось ровно на общую
   * разницу длин. Так тысяча таблиц переносится арифметикой, а `mapPos`
   * достаётся считанным штукам вокруг правки — иначе на каждое нажатие
   * клавиши приходилось бы по две тысячи вызовов.
   */
  let firstA = Number.POSITIVE_INFINITY;
  let lastA = -1;
  const touched: Region[] = [];
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (fromA < firstA) firstA = fromA;
    if (toA > lastA) lastA = toA;
    touched.push(
      regionOf(doc, doc.lineAt(fromB).number - 1, doc.lineAt(Math.min(toB, doc.length)).number + 1),
    );
  });

  const delta = doc.length - tr.startState.doc.length;
  const moved: TableSpan[] = [];
  for (const span of previous) {
    if (span.to <= firstA) moved.push(span);
    else if (span.from >= lastA) moved.push({ from: span.from + delta, to: span.to + delta });
    else {
      const from = tr.changes.mapPos(span.from, 1);
      const to = tr.changes.mapPos(span.to, -1);
      if (to > from) moved.push({ from, to });
    }
  }
  if (touched.length === 0) return { spans: moved, dirty: [] };

  let regions = merge(touched);
  /*
   * Таблица, задетая правкой хотя бы одной строкой, пересматривается целиком:
   * иначе удаление строки посреди таблицы оставило бы две половины, о которых
   * никто не узнал. Повторяем, пока границы растут: правка может склеить две
   * соседние таблицы в одну.
   */
  const absorbed = new Set<TableSpan>();
  for (let pass = 0; pass < 4; pass += 1) {
    const grown: Region[] = [];
    for (const span of moved) {
      if (absorbed.has(span) || !inRegions(regions, span)) continue;
      absorbed.add(span);
      /* Номера строк спрашиваем только у задетых таблиц — их единицы. */
      grown.push(regionOf(doc, doc.lineAt(span.from).number, doc.lineAt(span.to).number));
    }
    if (grown.length === 0) break;
    regions = merge([...regions, ...grown]);
  }

  const kept = moved.filter((span) => !inRegions(regions, span));
  const found = regions.flatMap((region) => scanLines(doc, region.fromLine, region.toLine));
  return { spans: [...kept, ...found].sort((a, b) => a.from - b.from), dirty: regions };
}

// ── Разбор исходника таблицы для показа ─────────────────────────────────────

/** Ячейка нарисованной таблицы. */
export interface ViewCell {
  text: string;
  /** Смещение начала текста ячейки от начала таблицы. */
  at: number;
}

export interface ViewTable {
  head: ViewCell[];
  body: ViewCell[][];
  aligns: ColumnAlign[];
  /** Число колонок: его задаёт строка-разделитель, как в GFM. */
  width: number;
}

/**
 * Разобрать кусок документа в модель показа.
 *
 * Строка, чистая функция, никакого состояния редактора: разбор проверяется
 * тестами без DOM и вызывается только тогда, когда таблица правда рисуется.
 */
export function parseTableSource(source: string): ViewTable | null {
  const lines = source.split('\n');
  const divider = lines[1];
  if (divider === undefined || !TABLE_DIVIDER.test(divider)) return null;

  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }

  const rowAt = (index: number): ViewCell[] =>
    cellSpans(lines[index] as string).map((cell) => ({
      text: cell.text,
      at: (starts[index] as number) + cell.from,
    }));

  const aligns = cellSpans(divider).map((cell) => alignOf(cell.text));
  const head = rowAt(0);
  const body = lines.slice(2).map((_line, index) => rowAt(index + 2));
  const width = Math.max(aligns.length, head.length, ...body.map((row) => row.length));
  return { head, body, aligns, width };
}

// ── Виджет ──────────────────────────────────────────────────────────────────

const MARK_CLASS: [keyof InlineToken, string][] = [
  ['bold', 'cm-z-strong'],
  ['italic', 'cm-z-em'],
  ['strike', 'cm-z-strike'],
  ['highlight', 'cm-z-highlight'],
  ['link', 'cm-z-link'],
];

/** Содержимое ячейки: те же классы начертаний, что и в живом тексте. */
function fillCell(cell: HTMLElement, source: string): void {
  for (const token of inlineTokens(source)) {
    if (token.br === true) {
      cell.append(document.createElement('br'));
      continue;
    }
    const classes = MARK_CLASS.filter(([key]) => token[key] === true).map(([, cls]) => cls);
    if (token.code === true) classes.push('cm-z-inline-code');
    if (classes.length === 0) {
      cell.append(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement(token.code === true ? 'code' : 'span');
    span.className = classes.join(' ');
    span.textContent = token.text;
    cell.append(span);
  }
}

const ALIGN_STYLE: Record<ColumnAlign, string> = {
  none: '',
  left: 'left',
  center: 'center',
  right: 'right',
};

class TableWidget extends WidgetType {
  constructor(private readonly source: string) {
    super();
  }

  /* Разный исходник — разная таблица. Одинаковый — CodeMirror оставит прежний
     DOM, и таблица не будет пересобираться на каждое движение курсора. */
  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cm-z-tableview';
    /* Виджет — не текст документа: править его внутри нельзя, правится
       исходник. Без этого браузер пустит каретку внутрь ячейки, а введённое
       там не попадёт в файл вовсе. */
    box.contentEditable = 'false';

    const table = document.createElement('table');
    const model = parseTableSource(this.source);
    if (model === null) {
      /* Досюда доходить нечему: границы ищутся тем же разделителем. Но пустой
         виджет на месте таблицы был бы потерей текста, поэтому — исходник. */
      box.textContent = this.source;
      return box;
    }

    const row = (cells: ViewCell[], head: boolean): HTMLTableRowElement => {
      const line = document.createElement('tr');
      for (let column = 0; column < model.width; column += 1) {
        const cell = document.createElement(head ? 'th' : 'td');
        const value = cells[column];
        const align = ALIGN_STYLE[model.aligns[column] ?? 'none'];
        if (align !== '') cell.style.textAlign = align;
        if (value !== undefined) {
          cell.dataset['at'] = String(value.at);
          fillCell(cell, value.text);
        }
        line.append(cell);
      }
      return line;
    };

    const head = document.createElement('thead');
    head.append(row(model.head, true));
    table.append(head);

    if (model.body.length > 0) {
      const body = document.createElement('tbody');
      for (const cells of model.body) body.append(row(cells, false));
      table.append(body);
    }
    box.append(table);

    /*
     * Тычок в ячейку ставит курсор в неё же — и таблица тут же становится
     * сырым markdown, потому что курсор оказался внутри.
     *
     * `click`, а не `pointerdown`: на телефоне палец сперва касается экрана и
     * только потом становится понятно, тычок это или прокрутка. Реагируй мы на
     * касание, любая прокрутка мимо таблицы разворачивала бы её в разметку и
     * поднимала клавиатуру.
     */
    box.addEventListener('click', (event) => {
      const target = event.target;
      const cell = target instanceof Element ? target.closest('[data-at]') : null;
      const at = cell === null ? 0 : Number(cell.getAttribute('data-at') ?? 0);
      /* Место виджета спрашиваем у представления, а не помним сами: при
         одинаковом исходнике CodeMirror оставляет ПРЕЖНИЙ объект виджета, и
         запомненные в нём позиции успели бы устареть. */
      const base = view.posAtDOM(box);
      const pos = Math.max(0, Math.min(view.state.doc.length, base + at));
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    });

    return box;
  }

  /* Все события внутри виджета — наши: разметка под ним не текст, и позиция
     курсора по клику считается по ячейке, а не по буквам. */
  override ignoreEvent(): boolean {
    return true;
  }
}

// ── Поле состояния ──────────────────────────────────────────────────────────

interface TableViewState {
  spans: TableSpan[];
  /** Таблица под курсором: у неё виджета нет, там правится сырой markdown. */
  active: TableSpan | null;
  deco: DecorationSet;
}

/** Пересекается ли таблица с выделением — с прилеганием к границам. */
function underCursor(state: EditorState, span: TableSpan): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= span.to && range.to >= span.from) return true;
  }
  return false;
}

function activeSpan(state: EditorState, spans: TableSpan[]): TableSpan | null {
  for (const span of spans) if (underCursor(state, span)) return span;
  return null;
}

function widgetFor(doc: Text, span: TableSpan): Range<Decoration> {
  const source = doc.sliceString(span.from, span.to);
  return Decoration.replace({ widget: new TableWidget(source), block: true }).range(
    span.from,
    span.to,
  );
}

function buildAll(state: EditorState, spans: TableSpan[], active: TableSpan | null): DecorationSet {
  /* Режим «Разметка» показывает файл как есть — никаких виджетов. */
  if (isRawMode(state)) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const span of spans) {
    if (span !== active) ranges.push(widgetFor(state.doc, span));
  }
  return RangeSet.of(ranges, true);
}

const tableViewField = StateField.define<TableViewState>({
  create(state) {
    const spans = tableSpans(state.doc);
    const active = activeSpan(state, spans);
    return { spans, active, deco: buildAll(state, spans, active) };
  },

  /**
   * Пересобирается ТОЛЬКО задетое.
   *
   * Соблазн собрать набор заново на каждую транзакцию велик и стоит дорого: в
   * заметке на мегабайт таблиц тысячи, а бюджет ввода — 16 мс на нажатие
   * (`test/perf.test.ts`). Поэтому прежний набор сдвигается вместе с текстом, а
   * заново считаются лишь таблицы в задетых кусках да две, у которых сменилось
   * состояние «под курсором».
   */
  update(value, tr) {
    /* Ничего, что влияет на показ, не менялось — отдаём прежний объект, и
       CodeMirror не станет ничего перерисовывать. */
    if (!tr.docChanged && tr.selection === undefined && tr.effects.length === 0) return value;

    const raw = isRawMode(tr.state);
    const wasRaw = isRawMode(tr.startState);
    const moved = tr.docChanged ? nextSpans(value.spans, tr) : { spans: value.spans, dirty: [] };
    const spans = moved.spans;

    /* Переключение режима «Разметка» — редкое событие, и считать его дешевле
       целиком, чем держать ради него отдельную ветку правки набора. */
    if (raw || wasRaw !== raw) {
      const active = raw ? null : activeSpan(tr.state, spans);
      return { spans, active, deco: raw ? Decoration.none : buildAll(tr.state, spans, active) };
    }

    const active = activeSpan(tr.state, spans);
    if (!tr.docChanged && active === value.active) return { ...value, spans };

    /* Куски, где набор устарел: задетые правкой плюс две таблицы, сменившие
       состояние «под курсором». */
    const dirty: TableSpan[] = moved.dirty.map((region) => ({
      from: region.from,
      to: region.to,
    }));
    const wasActive = value.active;
    if (wasActive !== null) {
      /* Таблица, из которой курсор ушёл: ей нужен виджет, а место её могла
         сдвинуть та же правка. */
      const from = tr.docChanged ? tr.changes.mapPos(wasActive.from, 1) : wasActive.from;
      const to = tr.docChanged ? tr.changes.mapPos(wasActive.to, -1) : wasActive.to;
      if (to >= from) dirty.push({ from, to });
    }
    /* Таблица, в которую курсор вошёл: с неё виджет надо снять. */
    if (active !== null) dirty.push({ from: active.from, to: active.to });
    if (dirty.length === 0) return { spans, active, deco: value.deco };

    const window = dirty.reduce(
      (acc, region) => ({ from: Math.min(acc.from, region.from), to: Math.max(acc.to, region.to) }),
      { from: Number.POSITIVE_INFINITY, to: -1 },
    );
    const add: Range<Decoration>[] = [];
    for (const span of spans) {
      if (span === active || !inRegions(dirty, span)) continue;
      add.push(widgetFor(tr.state.doc, span));
    }
    const deco = (tr.docChanged ? value.deco.map(tr.changes) : value.deco).update({
      filterFrom: window.from,
      filterTo: window.to,
      filter: (from, to) => !inRegions(dirty, { from, to }),
      add,
      sort: true,
    });
    return { spans, active, deco };
  },

  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
});

/**
 * Показ таблиц. Подключается рядом с live-preview и ПОСЛЕ `rawMode`: поле
 * читает его состояние, а поля состояния видят только объявленных раньше.
 */
export const tableView: Extension = [tableViewField];
