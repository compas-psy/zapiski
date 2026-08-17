/**
 * Импорт Notion: zip с `.md` и `.csv` (ТЗ §5.3).
 *
 * Notion-БД экспортируется как CSV — по BEHAVIOR §9 неподдерживаемое
 * содержимое «конвертируется в markdown-таблицу». Красные линии продукта
 * (никаких баз данных) соблюдаются: на выходе обычная таблица в заметке.
 * Имена файлов Notion содержат 32-символьный хеш — срезаем, иначе vault
 * выглядит как свалка.
 */
import { decode, emptyBundle, isMarkdownFile, unzip, type ImportBundle } from './types.js';
import { normalizePath } from '../util/path.js';

const NOTION_HASH = /\s+[0-9a-f]{32}(?=$|\.|\/)/gi;

export function importNotion(zip: Uint8Array): ImportBundle {
  return importNotionFiles(unzip(zip));
}

export function importNotionFiles(files: Map<string, Uint8Array>): ImportBundle {
  const bundle = emptyBundle();
  const folders = new Set<string>();
  /* Сколько ссылок переписали, срезая хвосты-идентификаторы. */
  let rewritten = 0;

  for (const [rawName, data] of files) {
    if (rawName.includes('__MACOSX/') || rawName.endsWith('.DS_Store')) continue;
    const name = normalizePath(stripNameHashes(rawName));
    if (name === '') continue;
    const slash = name.lastIndexOf('/');
    if (slash > 0) folders.add(name.slice(0, slash));

    if (isMarkdownFile(name)) {
      const stripped = stripHashes(decode(data));
      rewritten += stripped.rewritten;
      bundle.notes.push({
        relativePath: name.replace(/\.(markdown|txt)$/i, '.md'),
        body: stripped.text,
      });
      continue;
    }
    if (/\.csv$/i.test(name)) {
      const table = csvToMarkdownTable(decode(data));
      const title = (name.split('/').pop() as string).replace(/\.csv$/i, '');
      bundle.notes.push({
        relativePath: name.replace(/\.csv$/i, '.md'),
        body: `# ${title}\n\n${table}\n`,
      });
      bundle.warnings.push(`${name}: база Notion перенесена как markdown-таблица`);
      continue;
    }
    bundle.assets.push({ relativePath: name, data });
  }
  bundle.folders = folders.size;
  bundle.linksRewritten = rewritten;
  return bundle;
}

/**
 * Срезать хвосты-идентификаторы Notion.
 *
 * Это не косметика: имена файлов мы тоже срезаем, значит ссылки внутри текста
 * обязаны поехать за ними — иначе после импорта каждая внутренняя ссылка ведёт
 * в никуда. Число подмен возвращается, потому что отчёт обещает строку
 * «Ссылок переписано».
 */
function stripNameHashes(name: string): string {
  return name.replace(NOTION_HASH, '');
}

function stripHashes(text: string): { text: string; rewritten: number } {
  let rewritten = 0;
  const out = text.replace(NOTION_HASH, () => {
    rewritten += 1;
    return '';
  });
  return { text: out, rewritten };
}

/** Разбор CSV с кавычками и переводами строк внутри полей. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cell) => cell.trim() !== ''));
}

export function csvToMarkdownTable(text: string): string {
  const rows = parseCsv(text);
  if (rows.length === 0) return '';
  const header = rows[0] as string[];
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => {
      const cells = [...row];
      while (cells.length < header.length) cells.push('');
      return `| ${cells.slice(0, header.length).map(escape).join(' | ')} |`;
    }),
  ];
  return lines.join('\n');
}
