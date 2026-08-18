/**
 * Ссылка диалогом «Текст» + «Адрес» (ITERATION-1 §4).
 *
 * До этого кнопка вставляла `[текст]()` и ставила курсор внутрь скобок. Это
 * работает, но требует знать разметку: человек видит две пары скобок и должен
 * догадаться, что адрес идёт во вторую. §4 просит поле и поле.
 *
 * Здесь только модель — что показать в полях и что положить в текст. Диалог
 * рисует панель, и он же решает, где ему стоять; сюда не попадает ни строчки
 * про DOM, потому что проверять надо именно текст, который ляжет в файл.
 */
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';

export interface LinkDraft {
  /** Что показать в поле «Текст». */
  text: string;
  /** Что показать в поле «Адрес». */
  url: string;
  /** Диапазон, который заменит вставка. */
  from: number;
  to: number;
  /** Правим существующую ссылку, а не создаём новую. */
  editing: boolean;
}

/** Инлайн-ссылка целиком: `[текст](адрес)`. Без вложенных скобок в тексте. */
const LINK = /\[([^\]]*)\]\(([^)]*)\)/g;

/**
 * Что положить в поля диалога.
 *
 * Три случая, и все три встречаются: курсор внутри готовой ссылки — правим её;
 * есть выделение — оно становится текстом; пусто — оба поля пустые.
 */
export function linkDraft(state: EditorState): LinkDraft {
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);

  /* Курсор внутри существующей ссылки — предзаполняем оба поля и заменяем её
     целиком. Иначе правка ссылки означала бы «сначала сотри руками». */
  LINK.lastIndex = 0;
  for (let match = LINK.exec(line.text); match; match = LINK.exec(line.text)) {
    const start = line.from + match.index;
    const end = start + match[0].length;
    if (from >= start && to <= end) {
      return { text: match[1] ?? '', url: match[2] ?? '', from: start, to: end, editing: true };
    }
  }

  /*
   * Пробелы по краям выделения в подпись не идут: двойной щелчок по слову
   * отдаёт его вместе с пробелом за ним, и ссылка получала подчёркнутый хвост
   * `[слово ](адрес)`. Границы правки сдвигаются вместе с текстом — пробел
   * остаётся в тексте, снаружи ссылки.
   */
  const raw = state.sliceDoc(from, to);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const selected = raw.trim();
  const start = selected === '' ? from : from + leading;
  const end = selected === '' ? to : to - trailing;

  /* Выделили адрес, а не подпись — это тоже частый случай: скопировали ссылку,
     выделили, нажали кнопку. Тогда выделение идёт в «Адрес». */
  if (selected !== '' && isUrl(selected)) {
    return { text: '', url: selected, from: start, to: end, editing: false };
  }
  return { text: selected, url: '', from: start, to: end, editing: false };
}

/** Похоже ли выделение на адрес, а не на подпись. */
function isUrl(value: string): boolean {
  const text = value.trim();
  if (/\s/.test(text)) return false;
  return /^(https?|mailto|tel):/i.test(text) || /^www\./i.test(text) || text.startsWith('/');
}

/**
 * Изменение документа для готовой ссылки.
 *
 * Пустой адрес — валидная ссылка `[текст]()`, курсор встаёт внутрь скобок:
 * человек мог открыть диалог, чтобы подписать текст, а адрес вставить потом.
 * Пустой текст с адресом даёт `[](адрес)` — так же вставляет вложение ядро.
 */
export function applyLink(draft: LinkDraft, text: string, url: string): TransactionSpec {
  const insert = `[${text}](${url})`;
  const caret = url === '' ? draft.from + insert.length - 1 : draft.from + insert.length;
  return {
    changes: { from: draft.from, to: draft.to, insert },
    selection: EditorSelection.cursor(caret),
    scrollIntoView: true,
    userEvent: 'input.format',
  };
}
