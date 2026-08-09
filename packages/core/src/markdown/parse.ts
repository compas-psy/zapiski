/**
 * Разбор markdown в модель заметки (ТЗ §3.2): CommonMark + GFM + расширения
 * `[[wiki]]`, `==highlight==`, сноски, `#вложенные/теги`.
 *
 * Это не рендерер — рендерингом занимается packages/editor. Здесь только то,
 * что нужно ядру: заголовок, сниппет, теги, ссылки, признаки для `has:`
 * (BEHAVIOR §4) и подсчёт слов.
 */
import { countWords, truncate } from '../util/text.js';
import { splitFrontmatter, type Frontmatter } from './frontmatter.js';

export interface WikiLinkRef {
  /** Цель ссылки без якоря и алиаса: `Проекты/Идея`. */
  target: string;
  /** Часть после `#` — якорь на заголовок, если есть. */
  anchor?: string;
  /** Часть после `|`. */
  alias?: string;
  /** Смещения `[[...]]` в теле (без frontmatter) — нужны для переименования. */
  start: number;
  end: number;
}

export interface MarkdownLinkRef {
  text: string;
  url: string;
  image: boolean;
  start: number;
  end: number;
}

export interface ParsedNote {
  title: string;
  snippet: string;
  tags: string[];
  wikiLinks: WikiLinkRef[];
  links: MarkdownLinkRef[];
  hasImage: boolean;
  hasFile: boolean;
  hasTodo: boolean;
  hasLink: boolean;
  wordCount: number;
  frontmatter: Frontmatter | null;
  /** Тело без frontmatter — то, что видит пользователь в редакторе. */
  body: string;
  /** Тело без разметки — для индекса и фрагментов поиска. */
  plain: string;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i;

/**
 * Заголовок = первая строка файла (BEHAVIOR §2.2). Если она начинается
 * с `# ` — это H1 и заголовок; если нет — первая непустая строка становится
 * заголовком в списке, оставаясь в тексте обычным абзацем.
 */
export function extractTitle(body: string): string {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '---') continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const title = heading ? (heading[1] as string).trim() : line;
    return stripInline(title).trim();
  }
  return '';
}

/** Снимает инлайн-разметку, сохраняя текст: для заголовков и сниппета. */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) =>
      (alias ?? target).trim(),
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/==(.+?)==/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>\s][^>]*>/g, '');
}

/**
 * Полное снятие разметки. Содержимое код-блоков сохраняется (его ищут),
 * маркеры списков, цитат и заголовков убираются.
 */
export function stripMarkdown(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(rawLine);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rawLine)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(rawLine)) continue;
    let line = rawLine
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '');
    line = stripInline(line);
    out.push(line);
  }
  return out.join('\n');
}

/** Диапазоны код-блоков и инлайн-кода: внутри них теги и ссылки не считаются. */
function codeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^[ \t]*(```|~~~)[^\n]*$/gm;
  let open: number | null = null;
  let match: RegExpExecArray | null = fence.exec(body);
  while (match !== null) {
    if (open === null) open = match.index;
    else {
      ranges.push([open, match.index + match[0].length]);
      open = null;
    }
    match = fence.exec(body);
  }
  if (open !== null) ranges.push([open, body.length]);
  const inline = /`[^`\n]+`/g;
  let inlineMatch: RegExpExecArray | null = inline.exec(body);
  while (inlineMatch !== null) {
    ranges.push([inlineMatch.index, inlineMatch.index + inlineMatch[0].length]);
    inlineMatch = inline.exec(body);
  }
  return ranges;
}

function inRanges(ranges: Array<[number, number]>, position: number): boolean {
  return ranges.some(([start, end]) => position >= start && position < end);
}

/** Инлайн-теги `#вложенные/теги` (ТЗ §3.2). `# Заголовок` тегом не является. */
export function extractTags(body: string): string[] {
  const skip = codeRanges(body);
  const re = /(^|[^\p{L}\p{N}_/\\#])#([\p{L}][\p{L}\p{N}_-]*(?:\/[\p{L}][\p{L}\p{N}_-]*)*)/gu;
  const found: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    const at = match.index + (match[1] as string).length;
    if (!inRanges(skip, at)) {
      const tag = match[2] as string;
      const key = tag.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(tag);
      }
    }
    match = re.exec(body);
  }
  return found;
}

export function extractWikiLinks(body: string): WikiLinkRef[] {
  const skip = codeRanges(body);
  const re = /\[\[([^\]\n|#]+)(#[^\]\n|]+)?(\|[^\]\n]+)?\]\]/g;
  const out: WikiLinkRef[] = [];
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    if (!inRanges(skip, match.index)) {
      const ref: WikiLinkRef = {
        target: (match[1] as string).trim(),
        start: match.index,
        end: match.index + match[0].length,
      };
      if (match[2]) ref.anchor = match[2].slice(1).trim();
      if (match[3]) ref.alias = match[3].slice(1).trim();
      out.push(ref);
    }
    match = re.exec(body);
  }
  return out;
}

export function extractLinks(body: string): MarkdownLinkRef[] {
  const skip = codeRanges(body);
  const re = /(!?)\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
  const out: MarkdownLinkRef[] = [];
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    if (!inRanges(skip, match.index)) {
      out.push({
        image: match[1] === '!',
        text: match[2] as string,
        url: decodeURI((match[3] as string).trim()),
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    match = re.exec(body);
  }
  return out;
}

export function hasTodo(body: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]/m.test(body);
}

export function isImageUrl(url: string): boolean {
  return IMAGE_EXT.test(url.split('?')[0] ?? url);
}

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/** Полный разбор. `text` — содержимое файла целиком, вместе с frontmatter. */
export function parseNote(text: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(text);
  const wikiLinks = extractWikiLinks(body);
  const links = extractLinks(body);
  const plain = stripMarkdown(body);
  const title = extractTitle(body);

  // Сниппет — тело без строки заголовка, без разметки, ~200 знаков (contract.ts).
  const plainLines = plain.split('\n');
  const titleLineIndex = plainLines.findIndex((line) => line.trim() !== '');
  const rest = plainLines
    .slice(titleLineIndex + 1)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const snippet = truncate(rest, 200);

  const images = links.filter((l) => l.image || isImageUrl(l.url));
  const files = links.filter((l) => !l.image && !isImageUrl(l.url) && !isExternal(l.url));

  return {
    title,
    snippet,
    tags: extractTags(body),
    wikiLinks,
    links,
    hasImage: images.length > 0,
    hasFile: files.length > 0,
    hasTodo: hasTodo(body),
    hasLink: links.length > 0 || wikiLinks.length > 0,
    wordCount: countWords(plain),
    frontmatter,
    body,
    plain,
  };
}
