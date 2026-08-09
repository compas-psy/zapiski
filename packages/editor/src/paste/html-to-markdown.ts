/**
 * HTML из буфера обмена → markdown (BEHAVIOR §2.1, «Умная вставка»).
 *
 * Поддержано ровно то, что перечислено в ТЗ, плюс очевидные соседи:
 * заголовки, списки (включая вложенные и задачи), жирный/курсив/зачёркнутый,
 * подсветка, ссылки, изображения, цитаты, код (инлайн и блоками), таблицы,
 * разделители.
 *
 * Своя реализация вместо библиотеки: нужен предсказуемый результат для
 * кириллицы и наши расширения (`==подсветка==`), а весь конвертер — двести
 * строк, которые целиком покрыты тестами.
 */

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIGURE', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV',
  'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL',
]);

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

interface Ctx {
  /** Уровень вложенности списка — два пробела на уровень. */
  depth: number;
  /** Внутри `pre`/`code` ничего не экранируем. */
  raw: boolean;
}

/** Экранируем только то, что действительно способно сломать разметку. */
function escapeText(text: string): string {
  return text.replace(/([\\*[\]`])/g, '\\$1');
}

function collapse(text: string): string {
  return text.replace(/[\t\r\n ]+/g, ' ');
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function childrenOf(node: Node, ctx: Ctx): string {
  let out = '';
  for (let child = node.firstChild; child; child = child.nextSibling) {
    out += convert(child, ctx);
  }
  return out;
}

function listItems(list: Element, ctx: Ctx, ordered: boolean): string {
  const indent = '  '.repeat(ctx.depth);
  let index = 0;
  let out = '';
  for (let child = list.firstChild; child; child = child.nextSibling) {
    if (!isElement(child) || child.tagName !== 'LI') continue;
    index++;
    const inner = childrenOf(child, { ...ctx, depth: ctx.depth + 1 }).trim();
    const checkbox = child.querySelector(':scope > input[type="checkbox"]');
    const task = checkbox ? (checkbox.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
    const bullet = ordered ? `${index}. ` : '- ';
    // Вложенные списки уже несут собственный отступ (`depth + 1`), поэтому
    // повторно сдвигать строки нельзя — получится двойная вложенность.
    out += `${indent}${bullet}${task}${inner}\n`;
  }
  return out;
}

function tableToMarkdown(table: Element): string {
  const rows: string[][] = [];
  const trs = table.querySelectorAll('tr');
  for (const tr of Array.from(trs)) {
    const cells: string[] = [];
    for (const cell of Array.from(tr.children)) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
      cells.push(collapse(childrenOf(cell, { depth: 0, raw: false })).trim().replace(/\|/g, '\\|'));
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const copy = r.slice();
    while (copy.length < width) copy.push('');
    return copy;
  };
  const head = pad(rows[0] ?? []);
  const body = rows.slice(1).map(pad);
  const lines = [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return `\n${lines.join('\n')}\n\n`;
}

function convert(node: Node, ctx: Ctx): string {
  if (node.nodeType === 3) {
    const text = node.nodeValue ?? '';
    if (ctx.raw) return text;
    const collapsed = collapse(text);
    return escapeText(collapsed);
  }
  if (!isElement(node)) return '';
  const tag = node.tagName;
  if (SKIP_TAGS.has(tag)) return '';

  switch (tag) {
    case 'BR':
      return '  \n';
    case 'HR':
      return '\n\n---\n\n';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number.parseInt(tag.slice(1), 10);
      return `\n\n${'#'.repeat(level)} ${childrenOf(node, ctx).trim()}\n\n`;
    }
    case 'P':
    case 'DIV':
    case 'SECTION':
    case 'ARTICLE':
      return `\n\n${childrenOf(node, ctx).trim()}\n\n`;
    case 'STRONG':
    case 'B': {
      const inner = childrenOf(node, ctx).trim();
      return inner ? `**${inner}**` : '';
    }
    case 'EM':
    case 'I': {
      const inner = childrenOf(node, ctx).trim();
      return inner ? `*${inner}*` : '';
    }
    case 'DEL':
    case 'S':
    case 'STRIKE': {
      const inner = childrenOf(node, ctx).trim();
      return inner ? `~~${inner}~~` : '';
    }
    case 'MARK': {
      const inner = childrenOf(node, ctx).trim();
      return inner ? `==${inner}==` : '';
    }
    case 'CODE': {
      if (node.parentElement?.tagName === 'PRE') return childrenOf(node, { ...ctx, raw: true });
      const inner = childrenOf(node, { ...ctx, raw: true }).trim();
      return inner ? '`' + inner + '`' : '';
    }
    case 'PRE': {
      const body = childrenOf(node, { ...ctx, raw: true }).replace(/\n+$/, '');
      const lang = /language-([\w+-]+)/.exec(node.querySelector('code')?.className ?? '')?.[1] ?? '';
      return `\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    }
    case 'BLOCKQUOTE': {
      const body = childrenOf(node, ctx).trim();
      const quoted = body
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n');
      return `\n\n${quoted}\n\n`;
    }
    case 'UL':
      return `\n${listItems(node, ctx, false)}\n`;
    case 'OL':
      return `\n${listItems(node, ctx, true)}\n`;
    case 'LI':
      // Достигается только для «сиротских» li без списка-родителя.
      return `\n- ${childrenOf(node, ctx).trim()}\n`;
    case 'A': {
      const href = node.getAttribute('href') ?? '';
      const inner = childrenOf(node, ctx).trim();
      if (!href) return inner;
      if (!inner) return `<${href}>`;
      return `[${inner}](${href})`;
    }
    case 'IMG': {
      const src = node.getAttribute('src') ?? '';
      const alt = node.getAttribute('alt') ?? '';
      return src ? `![${alt}](${src})` : '';
    }
    case 'TABLE':
      return tableToMarkdown(node);
    case 'INPUT':
      // Чекбоксы уже учтены в `listItems`.
      return '';
    default:
      break;
  }

  const inner = childrenOf(node, ctx);
  return BLOCK_TAGS.has(tag) ? `\n\n${inner.trim()}\n\n` : inner;
}

/** Разобрать HTML и вернуть markdown. Пустая строка — если разбирать нечего. */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const body = parsed.body;
  if (!body) return '';
  const md = convert(body, { depth: 0, raw: false });
  return md
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
