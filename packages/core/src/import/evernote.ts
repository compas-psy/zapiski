/**
 * Импорт Evernote `.enex` (ТЗ §5.3).
 *
 * ENEX — XML с ENML внутри CDATA. Полноценный XML-парсер в ядро не тянем
 * (лишний вес на всех трёх платформах, ADR-0001): формат плоский и стабильный.
 * Сложная вёрстка таблиц по BEHAVIOR §9 конвертируется в markdown-таблицу, а
 * что не поддалось — упоминается в отчёте.
 */
import { decode, emptyBundle, type ImportBundle } from './types.js';
import { ATTACHMENTS_DIR } from '../util/path.js';
import { fromBase64, shortHash } from '../util/bytes.js';
import { isoDate } from '../util/text.js';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export function importEvernote(data: Uint8Array | string): ImportBundle {
  const xml = typeof data === 'string' ? data : decode(data);
  const bundle = emptyBundle();
  const notes = xml.match(/<note>[\s\S]*?<\/note>/g) ?? [];
  if (notes.length === 0) {
    bundle.warnings.push('В файле .enex не найдено ни одной заметки');
    return bundle;
  }

  for (const block of notes) {
    const title = unescapeXml(tagText(block, 'title') ?? 'Без названия');
    const created = tagText(block, 'created');
    const content = cdata(block, 'content') ?? '';
    const tags = (block.match(/<tag>([\s\S]*?)<\/tag>/g) ?? []).map((tag) =>
      unescapeXml(tag.replace(/<\/?tag>/g, '').trim()),
    );

    let body = enmlToMarkdown(content);

    // Ресурсы: base64 → attachments, ссылки по хешу заменяем на markdown.
    for (const resource of block.match(/<resource>[\s\S]*?<\/resource>/g) ?? []) {
      const base64 = tagText(resource, 'data');
      const mime = tagText(resource, 'mime') ?? 'application/octet-stream';
      const fileName = tagText(resource, 'file-name');
      if (base64 === null) continue;
      const bytes = fromBase64(base64);
      const extension = fileName ? fileName.slice(fileName.lastIndexOf('.')) : (MIME_EXT[mime] ?? '.bin');
      const date = isoDate(created ? parseEnexDate(created) : Date.now());
      const name = `${date}_${shortHash(bytes)}${extension}`;
      const target = `${ATTACHMENTS_DIR}/${name}`;
      bundle.assets.push({ relativePath: target, data: bytes });
      const isImage = mime.startsWith('image/');
      body += `\n\n${isImage ? '!' : ''}[${fileName ?? name}](${target})`;
    }

    const tagLine = tags.length > 0 ? `\n\n${tags.map((tag) => `#${tag.replace(/\s+/g, '-')}`).join(' ')}` : '';
    bundle.notes.push({
      relativePath: `${title.replace(/[/\\:*?"<>|]/g, '-')}.md`,
      body: `# ${title}\n\n${body.trim()}${tagLine}\n`,
    });
  }
  return bundle;
}

function tagText(block: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return match ? (match[1] as string).trim() : null;
}

function cdata(block: string, name: string): string | null {
  const raw = tagText(block, name);
  if (raw === null) return null;
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  return match ? (match[1] as string) : unescapeXml(raw);
}

/** `20260808T101500Z` → миллисекунды. */
export function parseEnexDate(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (!match) return Date.parse(value) || Date.now();
  const [, y, mo, d, h, mi, s] = match as unknown as string[];
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** ENML → markdown. Поддержаны заголовки, списки, чекбоксы, таблицы, ссылки. */
export function enmlToMarkdown(enml: string): string {
  let text = enml.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/g, '');
  text = text.replace(/<en-note[^>]*>/g, '').replace(/<\/en-note>/g, '');

  // Таблицы конвертируются целиком, до общей обработки строк.
  text = text.replace(/<table[\s\S]*?<\/table>/gi, (table) => tableToMarkdown(table));

  text = text
    .replace(/<en-todo[^>]*checked="true"[^>]*\/?>/gi, '- [x] ')
    .replace(/<en-todo[^>]*\/?>/gi, '- [ ] ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n${'#'.repeat(Number(level))} ${strip(inner)}\n`)
    .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `**${strip(inner)}**`)
    .replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `*${strip(inner)}*`)
    .replace(/<(s|strike|del)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => `~~${strip(inner)}~~`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => `\`${strip(inner)}\``)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `[${strip(inner)}](${href})`)
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, (_m, src: string) => `![](${src})`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${strip(inner)}`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => `\n> ${strip(inner)}\n`)
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<(p|div)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');

  return unescapeXml(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function strip(text: string): string {
  return unescapeXml(text.replace(/<[^>]+>/g, '')).trim();
}

function tableToMarkdown(table: string): string {
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rows.length === 0) return '';
  const cells = rows.map((row) => (row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? []).map((cell) => strip(cell)));
  const header = cells[0] ?? [];
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...cells.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ];
  return `\n\n${lines.join('\n')}\n\n`;
}
