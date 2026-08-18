/**
 * Разметка внутри ячейки таблицы — разобранная в куски с начертанием.
 *
 * ── Зачем отдельный разбор ──────────────────────────────────────────────────
 *
 * Нарисованная таблица (`table-view.ts`) заменяет строки документа виджетом, и
 * внутри виджета нет ни синтаксического дерева CodeMirror, ни его декораций:
 * там обычный DOM, который мы строим сами. А в ячейках люди пишут ровно то же,
 * что и в тексте: `**Не указано**`, `` `код` ``, ссылки. Показать их сырыми
 * звёздочками — значит поменять одну корявость на другую.
 *
 * Разбор нарочно маленький и построчный: ячейка таблицы по правилам GFM живёт
 * в одну строку, абзацев и списков в ней быть не может, перенос делается
 * только `<br>`. Поэтому здесь нет и не должно быть полного markdown — иначе
 * это второй парсер рядом с настоящим, который однажды разойдётся с ним в
 * трактовке. Всё, что сложнее перечисленного, остаётся текстом как есть: это
 * честнее, чем показать неправильно.
 */

/** Кусок текста ячейки с его начертанием. */
export interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** `==подсветка==` — своё расширение, оно есть и в живом показе. */
  highlight?: boolean;
  /** Ссылка: показываем подпись, адрес прячем — он в файле. */
  link?: boolean;
  /** Перенос строки внутри ячейки: единственный способ в GFM — `<br>`. */
  br?: boolean;
}

/** Активные начертания на данный момент разбора. */
type Marks = Omit<InlineToken, 'text' | 'br'>;

interface Delimiter {
  token: string;
  key: keyof Marks;
}

/*
 * Порядок важен: двойные маркеры проверяются раньше одинарных, иначе `**` было
 * бы прочитано как два курсива подряд.
 */
const DELIMITERS: Delimiter[] = [
  { token: '**', key: 'bold' },
  { token: '__', key: 'bold' },
  { token: '~~', key: 'strike' },
  { token: '==', key: 'highlight' },
  { token: '*', key: 'italic' },
  { token: '_', key: 'italic' },
];

/** Буква, цифра или подчёркивание — по ним решается «внутри слова или нет». */
const WORD = /[\p{L}\p{N}_]/u;
const isWord = (char: string | undefined): boolean => char !== undefined && WORD.test(char);
const isSpace = (char: string | undefined): boolean => char === undefined || char.trim() === '';

/**
 * Может ли маркер открыть начертание.
 *
 * Правило GFM про «прилегание»: `2 * 3 * 4` — это умножение, а не курсив,
 * потому что за открывающей звёздочкой стоит пробел. А `_` вдобавок не
 * работает внутри слова, иначе `max_drawdown_target` превратилось бы в
 * курсив — ровно то, чем чужие документы полны.
 */
function canOpen(source: string, index: number, token: string): boolean {
  const after = source[index + token.length];
  if (isSpace(after)) return false;
  if (token.startsWith('_') && isWord(source[index - 1])) return false;
  return true;
}

function canClose(source: string, index: number, token: string): boolean {
  const before = source[index - 1];
  if (isSpace(before)) return false;
  if (token.startsWith('_') && isWord(source[index + token.length])) return false;
  return true;
}

const BR = /^<br\s*\/?>/i;
const LINK = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/;
const WIKI = /^\[\[([^\]]+)\]\]/;

/** Разобрать содержимое ячейки. Вложенность начертаний сохраняется. */
export function inlineTokens(source: string, depth = 0): InlineToken[] {
  const out: InlineToken[] = [];
  const marks: Marks = {};
  let buffer = '';

  const flush = (): void => {
    if (buffer === '') return;
    out.push({ text: buffer, ...marks });
    buffer = '';
  };

  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const char = source[index] as string;

    /* Экранирование: `\|` внутри ячейки — обычная палка, а не граница. */
    if (char === '\\' && index + 1 < source.length) {
      buffer += source[index + 1] as string;
      index += 2;
      continue;
    }

    /* Код закрывается первым же обратным апострофом, и разметка внутри него
       разметкой не считается — иначе `` `a*b*c` `` показало бы курсив. */
    if (char === '`') {
      const close = source.indexOf('`', index + 1);
      if (close > index) {
        flush();
        out.push({ text: source.slice(index + 1, close), ...marks, code: true });
        index = close + 1;
        continue;
      }
    }

    const br = BR.exec(rest);
    if (br) {
      flush();
      out.push({ text: '', br: true });
      index += br[0].length;
      continue;
    }

    if (char === '[' && depth < 3) {
      const wiki = WIKI.exec(rest);
      if (wiki) {
        /* `[[цель|подпись]]` — показываем подпись. Палка внутри ссылки уже
           экранирована в исходнике таблицы, до нас доходит без слэша. */
        const inner = wiki[1] as string;
        const shown = inner.includes('|') ? (inner.split('|').pop() as string) : inner;
        flush();
        out.push({ text: shown.trim(), ...marks, link: true });
        index += wiki[0].length;
        continue;
      }
      const link = LINK.exec(rest);
      if (link) {
        flush();
        for (const token of inlineTokens(link[1] as string, depth + 1)) {
          out.push({ ...marks, ...token, link: true });
        }
        index += link[0].length;
        continue;
      }
    }

    const delimiter = DELIMITERS.find((item) => rest.startsWith(item.token));
    if (delimiter) {
      const { token, key } = delimiter;
      const open = marks[key] === true;
      /* Открывать начертание, которое ниже не закрывается, нельзя: одинокая
         звёздочка в тексте — это звёздочка, а не начало курсива до конца
         ячейки. */
      const closes = source.indexOf(token, index + token.length) >= 0;
      if (open && canClose(source, index, token)) {
        flush();
        delete marks[key];
        index += token.length;
        continue;
      }
      if (!open && closes && canOpen(source, index, token)) {
        flush();
        marks[key] = true;
        index += token.length;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return out;
}

/** Только текст, без начертаний: этим меряют пустоту ячейки. */
export function inlineText(source: string): string {
  return inlineTokens(source)
    .map((token) => (token.br === true ? '\n' : token.text))
    .join('');
}
