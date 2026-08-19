/**
 * Заметка для мессенджера: разметка, которую он ДЕЙСТВИТЕЛЬНО разбирает.
 *
 * ── Что просил заказчик ─────────────────────────────────────────────────────
 *
 * «Просто необходимо сделать так, чтобы при шеринге через стандартный
 * инструментарий Android в Telegram или Max форматирование там выглядело
 * точь-в-точь, как в ЗАПИСКАХ. Сейчас это там выглядит ужасно, но оба
 * мессенджера поддерживают MarkDown».
 *
 * ── Что оказалось на самом деле (проверено по исходникам Telegram) ──────────
 *
 * Мы отправляли markdown КАК ЕСТЬ, рассчитывая, что принимающая сторона его
 * разберёт. Она разбирает — но совсем не то, что мы посылали. Вот что делает
 * Telegram для Android с текстом, пришедшим через `ACTION_SEND`:
 *
 *  1. `LaunchActivity` читает `EXTRA_TEXT` и немедленно приводит его к строке
 *     (`textSequence.toString()`). Значит стилизованный текст слать бесполезно:
 *     любое оформление на уровне Android теряется по дороге.
 *  2. Перед отправкой текст проходит через `MediaDataController.getEntities`,
 *     а тот знает РОВНО шесть видов разметки, и они заданы регулярками:
 *         BOLD_PATTERN    = \*\*(.+?)\*\*
 *         ITALIC_PATTERN  = __(.+?)__
 *         SPOILER_PATTERN = \|\|(.+?)\|\|
 *         STRIKE_PATTERN  = ~~(.+?)~~
 *     плюс `код` и ```блок```.
 *  3. Ссылки становятся ссылками только из `URLSpan`, то есть из того, что
 *     человек набрал руками в поле ввода. Пришедший текстом `[имя](адрес)`
 *     ссылкой не станет НИКОГДА.
 *
 * Отсюда следует всё остальное: `# Заголовок`, `> цитата`, `- пункт`,
 * `[имя](адрес)`, `![](картинка.png)` и одиночные `*звёздочки*` не значат для
 * мессенджера ничего и приезжают мусором. Ровно это заказчик и увидел.
 *
 * ── Правило перевода ────────────────────────────────────────────────────────
 *
 * То, что мессенджер умеет, — отдаём его синтаксисом. То, чего не умеет, —
 * превращаем в текст, который читается сам, без всякой разметки: заголовок
 * жирным, маркер списка точкой, чекбокс квадратиком, ссылка голым адресом
 * (его мессенджеры подсвечивают сами).
 *
 * Ни одного маркера, который получатель не разберёт, в исходящем тексте не
 * остаётся — это и есть проверяемое обещание (`messenger.test.ts`).
 */
import { parseBlocks, type Block, type Inline, type ListItem } from './ast.js';
import { splitFrontmatter } from './frontmatter.js';

/**
 * Каким синтаксисом говорить с получателем.
 *
 * `telegram` — шесть видов разметки выше. Проверено по исходникам клиента.
 *
 * `plain` — не умеет ничего: только текст. Годится для мессенджера, про
 * который мы не знаем наверняка, и для «скопировать в буфер».
 */
export type MessengerFlavour = 'telegram' | 'plain';

export interface MessengerTextOptions {
  flavour?: MessengerFlavour;
}

/** Символы, которыми выкладывается то, для чего разметки у мессенджера нет. */
const BULLET = '•';
const TASK_DONE = '☑';
const TASK_OPEN = '☐';
const RULE = '———';
/**
 * Черта цитаты.
 *
 * Не разметка, а обычный символ, поэтому она видна ВСЕГДА — и когда получатель
 * разобрал курсив, и когда не разобрал ничего. Ровно так цитату и рисуют сами
 * мессенджеры: полоской слева.
 */
const QUOTE_BAR = '│ ';

/**
 * Наши html-вставки, которых у мессенджеров нет вовсе: подчёркивание, степень,
 * индекс, мелкий текст, сворачиваемый блок. Теги снимаем, содержимое остаётся —
 * иначе человек получит `<u>слово</u>` и будет прав, назвав это ужасным.
 */
const HTML_TAGS = /<\/?(?:u|sup|sub|small|details|summary|br)\s*\/?>/gi;

/** Подсветка `==текст==`: своего вида у мессенджеров нет, маркеры убираем. */
const HIGHLIGHT = /==([^=]+)==/g;

function plainText(text: string): string {
  return text.replace(HTML_TAGS, '').replace(HIGHLIGHT, '$1');
}

/**
 * Ссылка так, как её увидит получатель.
 *
 * `[имя](адрес)` мессенджер не разбирает, зато голый адрес подсвечивает сам.
 * Поэтому: если подпись совпадает с адресом — оставляем один адрес; если нет —
 * «подпись — адрес», чтобы не потерять ни смысла подписи, ни самой ссылки.
 */
function linkText(label: string, href: string): string {
  const clean = label.trim();
  const target = href.trim();
  if (target === '') return clean;
  if (clean === '' || clean === target) return target;
  /* `https://` в подписи — обычное дело для автоссылок: сравниваем без него. */
  if (target.replace(/^https?:\/\//, '').replace(/\/$/, '') === clean) return target;
  return `${clean} — ${target}`;
}

function inline(nodes: Inline[], flavour: MessengerFlavour): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += plainText(node.text);
        break;
      case 'strong':
        out += wrap(inline(node.children, flavour), '**', flavour);
        break;
      case 'em':
        /* Курсив у Telegram — ДВОЙНОЕ подчёркивание. Наша одиночная звёздочка
           его парсеру неизвестна, и до сих пор уезжала звёздочками. */
        out += wrap(inline(node.children, flavour), '__', flavour);
        break;
      case 'strike':
        out += wrap(inline(node.children, flavour), '~~', flavour);
        break;
      case 'mark':
        /* Подсветки у мессенджеров нет ни в каком виде — остаётся текст. */
        out += inline(node.children, flavour);
        break;
      case 'code':
        out += flavour === 'telegram' ? `\`${node.text}\`` : node.text;
        break;
      case 'link':
        out += linkText(inline(node.children, flavour), node.href);
        break;
      case 'wiki':
        /* Ссылка внутрь нашего хранилища у получателя никуда не ведёт. */
        out += plainText(node.label || node.target);
        break;
      case 'image': {
        /* Картинка живёт файлом в хранилище: у получателя её нет, а `![](…)`
           в тексте — просто мусор. Подпись, если она есть, сохраняем.

           Ширину (`![подпись|258](…)`) снимаем: это наша служебная запись, и
           на снимке заказчика она уехала в Telegram голым «|258». */
        const caption = node.alt.replace(/\|\s*\d+\s*$/, '').trim();
        out += caption === '' ? '' : plainText(caption);
        break;
      }
      case 'footnote':
        out += `[${node.label}]`;
        break;
      case 'break':
        out += '\n';
        break;
    }
  }
  return out;
}

/**
 * Обернуть в маркер, если внутри есть что оборачивать.
 *
 * Две оговорки, и обе — про чужой разбор, а не про нашу аккуратность.
 *
 * 1. Пустая пара маркеров опаснее, чем кажется: `**` `**` подряд у Telegram
 *    съедает всё между ними как жирный текст — регулярка нежадная и хватает
 *    ближайшую пару.
 * 2. ПАРА НЕ ПЕРЕХОДИТ НА НОВУЮ СТРОКУ. У Telegram разметка задана обычными
 *    java-регулярками (`__(.+?)__`), а точка в java по умолчанию не совпадает
 *    с переводом строки. Значит многострочная пара не разберётся вовсе, и
 *    получатель увидит сырые подчёркивания — то самое «выглядит ужасно».
 *    Поэтому многострочный кусок оборачивается построчно.
 */
function wrap(text: string, marker: string, flavour: MessengerFlavour): string {
  if (flavour !== 'telegram') return text;
  if (text.includes('\n')) {
    return text
      .split('\n')
      .map((line) => wrap(line, marker, flavour))
      .join('\n');
  }
  const trimmed = text.trim();
  if (trimmed === '') return text;
  const lead = text.slice(0, text.length - text.trimStart().length);
  const tail = text.slice(text.trimEnd().length);
  return `${lead}${marker}${trimmed}${marker}${tail}`;
}

function listBlock(items: ListItem[], ordered: boolean, flavour: MessengerFlavour): string[] {
  const lines: string[] = [];
  let counter = 0;
  for (const item of items) {
    const indent = '  '.repeat(Math.max(0, item.level));
    const body = inline(item.inline, flavour).trim();
    if (item.checked !== null) {
      lines.push(`${indent}${item.checked ? TASK_DONE : TASK_OPEN} ${body}`);
      continue;
    }
    if (ordered) {
      counter += 1;
      lines.push(`${indent}${counter}. ${body}`);
      continue;
    }
    /* Дефис у мессенджера ничего не значит, а точка читается списком сама. */
    lines.push(`${indent}${BULLET} ${body}`);
  }
  return lines;
}

/**
 * Таблица моноширинным блоком.
 *
 * Столбцы держатся только на равной ширине символов, а единственный способ
 * получить её в мессенджере — код-блок. Разметка GFM (`| --- |`) для него
 * пустой звук, и таблица приезжала лесенкой.
 */
function tableBlock(
  header: Inline[][],
  rows: Inline[][][],
  flavour: MessengerFlavour,
): string {
  const cells = [header, ...rows].map((row) => row.map((cell) => inline(cell, flavour).trim()));
  const widths: number[] = [];
  for (const row of cells) {
    row.forEach((text, column) => {
      widths[column] = Math.max(widths[column] ?? 0, [...text].length);
    });
  }
  const line = (row: string[]): string =>
    row.map((text, column) => text.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  const body = cells.map(line).join('\n');
  return flavour === 'telegram' ? `\`\`\`\n${body}\n\`\`\`` : body;
}

function blockText(block: Block, flavour: MessengerFlavour): string {
  switch (block.type) {
    case 'heading':
      /* Заголовков у мессенджеров нет. Жирная строка — то, чем их заменяют
         везде, и в ЗАПИСКАХ заголовок тоже прежде всего плотнее остального. */
      return wrap(inline(block.inline, flavour).trim(), '**', flavour);
    case 'paragraph':
      return inline(block.inline, flavour);
    case 'code':
      return flavour === 'telegram'
        ? `\`\`\`${block.lang}\n${block.text}\n\`\`\``
        : block.text;
    case 'quote':
      /* Цитату мессенджер из текста не соберёт: `>` для него ничего не значит.
         Собираем её сами из двух вещей — черты слева (обычный символ, виден
         всегда) и курсива (если получатель его разберёт). */
      return block.blocks
        .map((child) => wrap(blockText(child, flavour).trim(), '__', flavour))
        .join('\n')
        .split('\n')
        .map((line) => `${QUOTE_BAR}${line}`)
        .join('\n');
    case 'list':
      return listBlock(block.items, block.ordered, flavour).join('\n');
    case 'table':
      return tableBlock(block.header, block.rows, flavour);
    case 'hr':
      return RULE;
    case 'footnoteDef':
      return `${block.label}: ${inline(block.inline, flavour)}`;
  }
}

/**
 * Заметка в текст для мессенджера.
 *
 * Frontmatter снимается: это служебные поля заметки, получателю они не нужны
 * и читаются как сор в первой строке.
 */
export function toMessengerText(markdown: string, options: MessengerTextOptions = {}): string {
  const flavour = options.flavour ?? 'telegram';
  const { body } = splitFrontmatter(markdown);
  const blocks = parseBlocks(body);
  const parts: string[] = [];
  for (const block of blocks) {
    const text = blockText(block, flavour).replace(/[ \t]+$/gm, '');
    if (text.trim() === '') continue;
    parts.push(text);
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
