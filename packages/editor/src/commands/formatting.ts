/**
 * Команды форматирования — то, что дёргают хоткеи (BEHAVIOR §7) и тулбар
 * (BEHAVIOR §2.7). Ни одна из них не знает ни про клавиши, ни про кнопки.
 */

import { EditorSelection } from '@codemirror/state';
import type { ChangeSpec, EditorState, SelectionRange, StateCommand } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/** Разбор начала строки на отступ, блочный маркер и остальное. */
const MARKER =
  /^([\t ]*)((?:#{1,6}[\t ]+)|(?:>[\t ]?)|(?:(?:[-*+]|\d+[.)])[\t ]+(?:\[[ xX]\][\t ]+)?))?/;

export interface LineParts {
  indent: string;
  marker: string;
  rest: string;
}

export function splitLine(text: string): LineParts {
  const match = MARKER.exec(text);
  const indent = match?.[1] ?? '';
  const marker = match?.[2] ?? '';
  return { indent, marker, rest: text.slice(indent.length + marker.length) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Парные маркеры: **жирный**, *курсив*, ==подсветка==, ~~зачёркнутый~~
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Обернуть/развернуть выделение парными маркерами.
 * Без выделения вставляет пару и ставит курсор между маркерами — BEHAVIOR §2.7.
 */
/**
 * Что оборачивать, когда ничего не выделено.
 *
 * Обычно — пустая пара маркеров под курсором: человек нажал «B» и печатает
 * жирным, это привычно. Но внутри ссылки такой ответ бессмысленный, и
 * заказчик описал это прямо: «её нельзя обернуть жирным или курсивом».
 * Получалось `[Вот**** так выглядит ссылка](адрес)` — пара маркеров падала в
 * середину подписи, ссылка жирной не становилась, а текст ломался.
 *
 * Поэтому курсор внутри ссылки или картинки расширяется до всего узла:
 * `**[подпись](адрес)**`. Так это делают все редакторы, и так это остаётся
 * честным markdown — ссылка внутри выделения жирного, а не наоборот.
 */
function wrapTarget(state: EditorState, range: SelectionRange): SelectionRange {
  if (!range.empty) return range;
  let node = syntaxTree(state).resolveInner(range.from, 0);
  while (node.parent) {
    if (node.name === 'Link' || node.name === 'Image') {
      return EditorSelection.range(node.from, node.to);
    }
    node = node.parent;
  }
  return range;
}

export function toggleWrap(open: string, close: string = open): StateCommand {
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((cursor) => {
      const range = wrapTarget(state, cursor);
      const outerFrom = range.from - open.length;
      const outerTo = range.to + close.length;
      const hasOuter =
        outerFrom >= 0 &&
        outerTo <= state.doc.length &&
        state.sliceDoc(outerFrom, range.from) === open &&
        state.sliceDoc(range.to, outerTo) === close;

      if (hasOuter) {
        return {
          changes: [
            { from: outerFrom, to: range.from },
            { from: range.to, to: outerTo },
          ],
          range: EditorSelection.range(outerFrom, range.to - open.length),
        };
      }

      const inner = state.sliceDoc(range.from, range.to);
      if (
        inner.length >= open.length + close.length &&
        inner.startsWith(open) &&
        inner.endsWith(close)
      ) {
        return {
          changes: [
            { from: range.from, to: range.from + open.length },
            { from: range.to - close.length, to: range.to },
          ],
          range: EditorSelection.range(range.from, range.to - open.length - close.length),
        };
      }

      return {
        changes: [
          { from: range.from, insert: open },
          { from: range.to, insert: close },
        ],
        range: range.empty
          ? EditorSelection.cursor(range.from + open.length)
          : EditorSelection.range(range.from + open.length, range.to + open.length),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

export const toggleBold: StateCommand = toggleWrap('**');
export const toggleItalic: StateCommand = toggleWrap('*');
/** Ctrl+U — «подчёркнутый» в наших заметках это `==подсветка==` (BEHAVIOR §7). */
export const toggleHighlight: StateCommand = toggleWrap('==');
export const toggleStrike: StateCommand = toggleWrap('~~');
export const toggleInlineCode: StateCommand = toggleWrap('`');

// ─────────────────────────────────────────────────────────────────────────────
// Блочные маркеры
// ─────────────────────────────────────────────────────────────────────────────

type MarkerFor = (parts: LineParts, indexInSelection: number) => string;

/** Применить блочный маркер к строкам выделения; повторный вызов снимает его. */
function applyBlockMarker(markerFor: MarkerFor, matches: (marker: string) => boolean): StateCommand {
  return ({ state, dispatch }) => {
    const lineNumbers: number[] = [];
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number;
      const last = state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        lineNumbers.push(n);
      }
    }
    if (!lineNumbers.length) return false;

    const parts = lineNumbers.map((n) => splitLine(state.doc.line(n).text));
    const allMarked = parts.every((p) => matches(p.marker));

    /*
     * Меняется ТОЛЬКО маркер, а не строка целиком.
     *
     * Дефект, ради которого это переписано: «при вставке списка добавляется
     * `-`, но курсор встаёт перед ним». Раньше строка заменялась целиком
     * (`from: line.from, to: line.to`), и позиция курсора внутри заменённого
     * куска схлопывалась к его началу — то есть перед только что добавленным
     * маркером. Точечная правка отображает позиции сама: текст остаётся на
     * месте, курсор едет вместе с ним.
     */
    const changes: ChangeSpec[] = [];
    lineNumbers.forEach((n, i) => {
      const line = state.doc.line(n);
      const part = parts[i];
      if (!part) return;
      const marker = allMarked ? '' : markerFor(part, i);
      if (marker === part.marker) return;
      const at = line.from + part.indent.length;
      changes.push({ from: at, to: at + part.marker.length, insert: marker });
    });
    if (!changes.length) return false;

    /*
     * Курсор явно переносится ЗА вставленный маркер.
     *
     * Точечной правки мало, и это выяснилось на пустой строке: курсор стоит в
     * позиции 0, маркер вставляется туда же, и по умолчанию позиция
     * «прилипает» к началу вставки — получается `|- `, курсор перед дефисом.
     * Ровно это заказчик и описал: «добавляется `-`, но курсор встаёт перед
     * этим символом», и на непустой строке дефект не воспроизводился.
     *
     * `map(changes, 1)` двигает позицию в другую сторону — за вставленное.
     */
    const changeSet = state.changes(changes);
    dispatch(
      state.update({
        changes: changeSet,
        selection: state.selection.map(changeSet, 1),
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    );
    return true;
  };
}

const isHeading = (marker: string, level: number): boolean =>
  new RegExp(`^#{${level}}[\\t ]+$`).test(marker);

/** Ctrl+1…6 — заголовок уровня; Ctrl+0 — обычный абзац. */
export function setHeading(level: number): StateCommand {
  if (level === 0) {
    // Ctrl+0 всегда снимает маркер и никогда не возвращает его обратно.
    return applyBlockMarker(
      () => '',
      () => false,
    );
  }
  return applyBlockMarker(
    () => `${'#'.repeat(level)} `,
    (marker) => isHeading(marker, level),
  );
}

/** «H» в тулбаре: H1 → H2 → H3 → обычный (BEHAVIOR §2.7). */
export const cycleHeading: StateCommand = (target) => {
  const { state } = target;
  const line = state.doc.lineAt(state.selection.main.head);
  const { marker } = splitLine(line.text);
  const level = /^(#{1,6})[\t ]+$/.exec(marker)?.[1]?.length ?? 0;
  const next = level === 0 ? 1 : level === 1 ? 2 : level === 2 ? 3 : 0;
  return setHeading(next)(target);
};

/**
 * Маркерный список. Символ маркера настраивается (замечание 10): все три
 * варианта — канонический markdown, и выбор меняет ТЕКСТ файла, а не показ.
 */
export function bulletListWith(marker: '-' | '*' | '+'): StateCommand {
  return applyBlockMarker(
    () => `${marker} `,
    (found) => /^[-*+][\t ]+$/.test(found),
  );
}

export const toggleBulletList: StateCommand = bulletListWith('-');

export const toggleOrderedList: StateCommand = applyBlockMarker(
  (_parts, index) => `${index + 1}. `,
  (marker) => /^\d+[.)][\t ]+$/.test(marker),
);

export const toggleTaskList: StateCommand = applyBlockMarker(
  () => '- [ ] ',
  (marker) => /^(?:[-*+]|\d+[.)])[\t ]+\[[ xX]\][\t ]+$/.test(marker),
);

export const toggleQuote: StateCommand = applyBlockMarker(
  () => '> ',
  (marker) => /^>[\t ]?$/.test(marker),
);

// ─────────────────────────────────────────────────────────────────────────────
// Вставки
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ctrl+Shift+C — код-блок.
 *
 * Без выделения блок встаёт СВОЕЙ строкой после текущей, а не в позицию
 * курсора. Дефект, ради которого это переписано: курсор стоял в середине
 * набранной строки, и вставка разрывала её пополам — открывающая ограда
 * оказывалась приклеена к тексту слева, закрывающая улетала к тексту справа.
 * Дальше человек жал Enter, ограды переставали быть парой, и «в блок кода
 * захватывало всё, что идёт ниже», до конца заметки.
 *
 * С выделением поведение другое и остаётся прежним: кодом становится тот
 * абзац, который выделен, — этого заказчик и ждёт.
 */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (range.empty) {
    const line = state.doc.lineAt(range.head);
    /* Пустая строка — блок встаёт прямо в неё; непустую не трогаем и
       отбиваем блок пустой строкой, иначе markdown приклеит ограду к абзацу. */
    const prefix = line.text.trim().length ? '\n\n' : '';
    const at = line.to;
    const insert = `${prefix}\`\`\`\n\n\`\`\``;
    dispatch(
      state.update({
        changes: { from: at, insert },
        /* Курсор — в пустую строку внутри блока: писать будут там. */
        selection: { anchor: at + prefix.length + 4 },
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    );
    return true;
  }
  const from = state.doc.lineAt(range.from).from;
  const to = state.doc.lineAt(range.to).to;
  const body = state.sliceDoc(from, to);
  const insert = '```\n' + body + '\n```';
  dispatch(
    state.update({
      changes: { from, to, insert },
      selection: { anchor: from + 4, head: from + 4 + body.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** Ctrl+L — ссылка. С выделением оборачивает его в `[текст](url)`. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    return {
      changes: { from: range.from, to: range.to, insert },
      // Курсор — внутрь скобок для url.
      range: EditorSelection.cursor(range.from + insert.length - 1),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

/** Ctrl+Shift+W — wiki-ссылка. Пустая открывает автодополнение заметок. */
export const insertWikiLink: StateCommand = ({ state, dispatch }) => {
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[[${text}]]`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + 2 + text.length),
    };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

/** Тулбар «⋯» → таблица: минимальная GFM-таблица 2×2 с шапкой. */
export const insertTable: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  const prefix = line.text.trim().length ? '\n\n' : '';
  /*
   * Три столбца и две строки тела — как в приложениях, откуда человек
   * приходит (заказчик прислал снимки Telegram именно с такой заготовкой).
   *
   * Прежние два столбца и одна строка выглядели не таблицей, а парой ячеек:
   * первое, что приходилось делать после вставки, — добавлять недостающее.
   * Лишний столбец удалить одним нажатием проще, чем добавить два.
   */
  const table =
    '| Колонка | Колонка | Колонка |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
  const at = line.to;
  dispatch(
    state.update({
      changes: { from: at, insert: prefix + table },
      selection: { anchor: at + prefix.length + 2 },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/**
 * Тулбар → фото: готовая разметка `![](attachments/…)` в позицию курсора.
 *
 * Файл к этому моменту уже скопирован в `attachments/` — команда только
 * вставляет ссылку на него. Разделение намеренное: копирование зависит от
 * хранилища и умеет падать, а вставка текста — нет.
 */
/**
 * Строка, в которой нет ничего, кроме картинок и пробелов.
 *
 * Нужна, чтобы вторая картинка встала РЯДОМ с первой, а не под ней. Условие
 * строгое: одна буква рядом — и строка уже абзац с картинкой, дописывать в
 * него нельзя.
 */
const IMAGES_ONLY = /^\s*!\[[^\]]*\]\([^)]*\)(?:\s*!\[[^\]]*\]\([^)]*\))*\s*$/;

export function isImagesOnlyLine(text: string): boolean {
  return text.trim().length > 0 && IMAGES_ONLY.test(text);
}

/**
 * Вставить картинку.
 *
 * ── Почему рядом, а не под ─────────────────────────────────────────────────
 *
 * Заказчик: «если добавлять картинки в ЗАПИСКУ, то они размещаются только друг
 * под другом». Так и было, и причин было две. Первая — в оформлении: обёртка
 * картинки была блоком на всю ширину колонки (исправлено в `base-theme.ts`).
 * Вторая — здесь: команда всегда открывала новую строку, а строка в CodeMirror
 * это отдельный блок, и рядом такие блоки не встанут никаким CSS.
 *
 * Теперь картинки, добавленные одна за другой, попадают на ОДНУ строку —
 * `![](a.png) ![](b.png)`. Это обычный markdown: любой чужой редактор тоже
 * покажет их в ряд, то есть файл не становится «нашим».
 *
 * Группу разрывает пустая строка: она была разрывом абзаца и в markdown, и
 * в голове человека. Поэтому правило смотрит на строку прямо перед курсором,
 * а не на «последнюю непустую» — иначе картинка через два абзаца приклеивалась
 * бы к давнему ряду.
 */
export function insertImage(markdown: string): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const line = state.doc.lineAt(range.head);

    /*
     * Куда дописывать в ряд:
     *  · курсор стоит в строке с одними картинками — в неё же;
     *  · курсор на пустой строке сразу под такой строкой — в неё. Это главный
     *    случай: после вставки курсор оказывается именно там, и вторая
     *    картинка иначе уходила бы вниз.
     */
    const row =
      isImagesOnlyLine(line.text)
        ? line
        : line.text.trim().length === 0 && line.number > 1
          ? state.doc.line(line.number - 1)
          : null;

    if (row !== null && isImagesOnlyLine(row.text)) {
      const insert = `${row.text.endsWith(' ') ? '' : ' '}${markdown}`;
      dispatch(
        state.update({
          changes: { from: row.to, insert },
          selection: { anchor: row.to + insert.length },
          scrollIntoView: true,
          userEvent: 'input.format',
        }),
      );
      return true;
    }

    /* Картинка в середине абзаца ломает чтение — ставим её своим блоком. */
    const prefix = line.text.trim().length ? '\n\n' : '';
    const at = line.to;
    dispatch(
      state.update({
        changes: { from: at, insert: `${prefix}${markdown}\n` },
        selection: { anchor: at + prefix.length + markdown.length + 1 },
        scrollIntoView: true,
        userEvent: 'input.format',
      }),
    );
    return true;
  };
}

/** Тулбар «⋯» → разделитель. */
export const insertDivider: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const prefix = line.text.trim().length ? '\n\n' : '';
  const at = line.to;
  dispatch(
    state.update({
      changes: { from: at, insert: `${prefix}---\n` },
      selection: { anchor: at + prefix.length + 4 },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};

/** Тулбар «⋯» → сноска: ссылка в тексте и заготовка определения в конце. */
export const insertFootnote: StateCommand = ({ state, dispatch }) => {
  const existing = state.doc.toString().match(/\[\^(\d+)\]/g) ?? [];
  const nums = existing
    .map((s) => Number.parseInt(s.replace(/\D/g, ''), 10))
    .filter((n) => Number.isFinite(n));
  const id = (nums.length ? Math.max(...nums) : 0) + 1;
  const at = state.selection.main.head;
  const end = state.doc.length;
  dispatch(
    state.update({
      changes: [
        { from: at, insert: `[^${id}]` },
        { from: end, insert: `\n\n[^${id}]: ` },
      ],
      selection: { anchor: end + `[^${id}]`.length + `\n\n[^${id}]: `.length },
      scrollIntoView: true,
      userEvent: 'input.format',
    }),
  );
  return true;
};
