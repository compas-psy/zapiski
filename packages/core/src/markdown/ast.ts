/**
 * Компактное синтаксическое дерево markdown — общая основа для экспорта в
 * HTML, PDF и DOCX (ТЗ §5.3). Рендеринг в редакторе живёт в
 * `packages/editor` на CodeMirror; здесь нужен только конвертер форматов,
 * поэтому дерево нарочно маленькое: CommonMark + GFM + расширения ЗАПИСОК.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'mark'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'wiki'; target: string; label: string }
  | { type: 'image'; src: string; alt: string }
  | { type: 'footnote'; label: string }
  | { type: 'break' };

export interface ListItem {
  inline: Inline[];
  /** `null` — обычный пункт, иначе чекбокс (GFM). */
  checked: boolean | null;
  level: number;
}

export type Block =
  | { type: 'heading'; level: number; inline: Inline[] }
  | { type: 'paragraph'; inline: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' }
  | { type: 'footnoteDef'; label: string; inline: Inline[] };

const INLINE_PATTERNS: Array<{ re: RegExp; make: (match: RegExpExecArray) => Inline }> = [
  { re: /^`([^`]+)`/, make: (m) => ({ type: 'code', text: m[1] as string }) },
  {
    re: /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/,
    make: (m) => ({ type: 'image', src: m[2] as string, alt: m[1] as string }),
  },
  {
    re: /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/,
    make: (m) => ({ type: 'wiki', target: (m[1] as string).trim(), label: (m[2] ?? m[1] ?? '').trim() }),
  },
  { re: /^\[\^([^\]]+)\]/, make: (m) => ({ type: 'footnote', label: m[1] as string }) },
];

/** Разбор инлайн-разметки строки. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  let i = 0;
  const flush = (): void => {
    if (buffer !== '') out.push({ type: 'text', text: buffer });
    buffer = '';
  };
  while (i < text.length) {
    const rest = text.slice(i);
    let matched = false;
    for (const pattern of INLINE_PATTERNS) {
      const match = pattern.re.exec(rest);
      if (!match) continue;
      flush();
      out.push(pattern.make(match));
      i += match[0].length;
      matched = true;
      break;
    }
    if (matched) continue;

    const linkMatch = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
    if (linkMatch) {
      flush();
      out.push({ type: 'link', href: linkMatch[2] as string, children: parseInline(linkMatch[1] as string) });
      i += linkMatch[0].length;
      continue;
    }
    const wrapped = matchWrapped(rest);
    if (wrapped) {
      flush();
      out.push(wrapped.node);
      i += wrapped.length;
      continue;
    }
    buffer += text[i] as string;
    i += 1;
  }
  flush();
  return out;
}

function matchWrapped(rest: string): { node: Inline; length: number } | null {
  const table: Array<[string, Inline['type']]> = [
    ['***', 'strong'],
    ['**', 'strong'],
    ['~~', 'strike'],
    ['==', 'mark'],
    ['*', 'em'],
    ['__', 'strong'],
    ['_', 'em'],
  ];
  for (const [marker, type] of table) {
    if (!rest.startsWith(marker)) continue;
    const end = rest.indexOf(marker, marker.length);
    if (end === -1) continue;
    const inner = rest.slice(marker.length, end);
    if (inner.trim() === '') continue;
    const children = parseInline(inner);
    const node =
      type === 'strong'
        ? ({ type: 'strong', children } as Inline)
        : type === 'em'
          ? ({ type: 'em', children } as Inline)
          : type === 'strike'
            ? ({ type: 'strike', children } as Inline)
            : ({ type: 'mark', children } as Inline);
    return { node, length: end + marker.length };
  }
  return null;
}

/** Разбор блоков. Вход — тело заметки без frontmatter. */
export function parseBlocks(body: string): Block[] {
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const lang = fence[2] ?? '';
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) {
        buffer.push(lines[i] as string);
        i += 1;
      }
      i += 1;
      blocks.push({ type: 'code', lang, text: buffer.join('\n') });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] as string).length,
        inline: parseInline((heading[2] as string).trim()),
      });
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const footnote = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      blocks.push({ type: 'footnoteDef', label: footnote[1] as string, inline: parseInline(footnote[2] as string) });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] as string)) {
        buffer.push((lines[i] as string).replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(buffer.join('\n')) });
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] as string)) {
      const header = splitRow(line).map((cell) => parseInline(cell));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string)) {
        rows.push(splitRow(lines[i] as string).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2] as string);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] as string);
        if (!current) break;
        const isOrdered = /\d/.test(current[2] as string);
        if (isOrdered !== ordered) break;
        let text = current[3] as string;
        let checked: boolean | null = null;
        const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (checkbox) {
          checked = (checkbox[1] as string).toLowerCase() === 'x';
          text = checkbox[2] as string;
        }
        items.push({ inline: parseInline(text), checked, level: Math.floor((current[1] as string).length / 2) });
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const buffer: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== '' && !isBlockStart(lines[i] as string)) {
      buffer.push(lines[i] as string);
      i += 1;
    }
    if (buffer.length === 0) {
      buffer.push(line);
      i += 1;
    }
    blocks.push({ type: 'paragraph', inline: parseInline(buffer.join('\n')) });
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s*(```|~~~)/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^(\s*)([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line)
  );
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Плоский текст узлов — для DOCX и для alt-текстов. */
export function inlineToText(nodes: Inline[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'code':
        out += node.text;
        break;
      case 'image':
        out += node.alt;
        break;
      case 'wiki':
        out += node.label === '' ? node.target : node.label;
        break;
      case 'footnote':
        break;
      case 'break':
        out += '\n';
        break;
      default:
        out += inlineToText(node.children);
    }
  }
  return out;
}
