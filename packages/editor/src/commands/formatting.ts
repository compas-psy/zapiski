/**
 * Команды форматирования — то, что дёргают хоткеи (BEHAVIOR §7) и тулбар
 * (BEHAVIOR §2.7). Ни одна из них не знает ни про клавиши, ни про кнопки.
 */

import { EditorSelection } from '@codemirror/state';
import type { ChangeSpec, StateCommand } from '@codemirror/state';

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
export function toggleWrap(open: string, close: string = open): StateCommand {
  return ({ state, dispatch }) => {
    const tr = state.changeByRange((range) => {
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

    const changes: ChangeSpec[] = [];
    lineNumbers.forEach((n, i) => {
      const line = state.doc.line(n);
      const part = parts[i];
      if (!part) return;
      const marker = allMarked ? '' : markerFor(part, i);
      const next = `${part.indent}${marker}${part.rest}`;
      if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    });
    if (!changes.length) return false;

    dispatch(state.update({ changes, scrollIntoView: true, userEvent: 'input.format' }));
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

export const toggleBulletList: StateCommand = applyBlockMarker(
  () => '- ',
  (marker) => /^[-*+][\t ]+$/.test(marker),
);

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
  const table = '| Колонка | Колонка |\n| --- | --- |\n|  |  |';
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
export function insertImage(markdown: string): StateCommand {
  return ({ state, dispatch }) => {
    const range = state.selection.main;
    const line = state.doc.lineAt(range.head);
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
