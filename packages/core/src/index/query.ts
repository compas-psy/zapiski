/**
 * Разбор строки поиска в `SearchQuery` (contract.ts). Операторы по BEHAVIOR §4:
 * `tag:` · `folder:` · `before:` · `after:` · `has:image|file|todo|link` ·
 * `"точная фраза"` · `-исключение`.
 *
 * Операторы разбираются в AST до обращения к индексу (ADR-0002): `tag`/`folder`/
 * `before`/`after`/`has` — фильтры по метаданным, не по тексту.
 */
import type { SearchFilters, SearchQuery } from '../contract.js';

const HAS_VALUES = new Set(['image', 'file', 'todo', 'link']);

/**
 * Дата оператора `before:`/`after:`. Поддержаны ISO `2026-08-01`, `ГГГГ-ММ`,
 * `ГГГГ` и русские относительные слова — BEHAVIOR §4 приводит `after:вчера`.
 */
export function parseDateToken(token: string, now: number = Date.now()): number | null {
  const text = token.trim().toLowerCase();
  const day = 86_400_000;
  const startOfDay = (timestamp: number): number => {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  };
  switch (text) {
    case 'сегодня':
    case 'today':
      return startOfDay(now);
    case 'вчера':
    case 'yesterday':
      return startOfDay(now - day);
    case 'неделя':
    case 'неделю':
    case 'week':
      return startOfDay(now - 7 * day);
    case 'месяц':
    case 'month':
      return startOfDay(now - 30 * day);
    case 'год':
    case 'year':
      return startOfDay(now - 365 * day);
    default:
      break;
  }
  if (/^\d{4}$/.test(text)) return Date.UTC(Number(text), 0, 1);
  if (/^\d{4}-\d{2}$/.test(text)) {
    const [year, month] = text.split('-').map(Number) as [number, number];
    return Date.UTC(year, month - 1, 1);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, dayOfMonth] = text.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, dayOfMonth);
  }
  return null;
}

interface RawToken {
  text: string;
  quoted: boolean;
}

/** Разбивает строку на токены, уважая кавычки. */
function lex(input: string): RawToken[] {
  const out: RawToken[] = [];
  let buffer = '';
  let quote = false;
  let quotedToken = false;
  const flush = (): void => {
    if (buffer !== '') out.push({ text: buffer, quoted: quotedToken });
    buffer = '';
    quotedToken = false;
  };
  for (const char of input) {
    if (char === '"') {
      quote = !quote;
      quotedToken = true;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      flush();
      continue;
    }
    buffer += char;
  }
  flush();
  return out;
}

export function parseQuery(input: string, now: number = Date.now()): SearchQuery {
  const filters: SearchFilters = {};
  const words: string[] = [];
  const phrases: string[] = [];
  const exclude: string[] = [];

  for (const token of lex(input)) {
    let text = token.text;
    let negated = false;
    if (!token.quoted && text.startsWith('-') && text.length > 1) {
      negated = true;
      text = text.slice(1);
    }
    const operator = /^([a-zA-Zа-яА-Я]+):(.*)$/.exec(token.quoted ? '' : text);
    if (operator) {
      const name = (operator[1] as string).toLowerCase();
      const value = operator[2] as string;
      if (value === '') continue;
      switch (name) {
        case 'tag':
        case 'тег':
          (filters.tag ??= []).push(value.replace(/^#/, ''));
          continue;
        case 'folder':
        case 'папка':
          (filters.folder ??= []).push(value);
          continue;
        case 'before':
        case 'до': {
          const date = parseDateToken(value, now);
          if (date !== null) filters.before = date;
          continue;
        }
        case 'after':
        case 'после': {
          const date = parseDateToken(value, now);
          if (date !== null) filters.after = date;
          continue;
        }
        case 'has':
        case 'есть': {
          const kind = value.toLowerCase();
          if (HAS_VALUES.has(kind)) {
            (filters.has ??= []).push(kind as 'image' | 'file' | 'todo' | 'link');
          }
          continue;
        }
        default:
          break;
      }
    }
    if (negated) {
      exclude.push(text);
      continue;
    }
    if (token.quoted && text.includes(' ')) {
      phrases.push(text);
      continue;
    }
    if (token.quoted) phrases.push(text);
    words.push(text);
  }

  if (phrases.length > 0) filters.phrases = phrases;
  if (exclude.length > 0) filters.exclude = exclude;
  return { text: words.join(' '), filters };
}

/** Обратная сборка строки из запроса — для синхронизации строки и чипов (BEHAVIOR §4). */
export function formatQuery(query: SearchQuery): string {
  const parts: string[] = [];
  if (query.text.trim() !== '') parts.push(query.text.trim());
  for (const phrase of query.filters.phrases ?? []) parts.push(`"${phrase}"`);
  for (const tag of query.filters.tag ?? []) parts.push(`tag:${tag}`);
  for (const folder of query.filters.folder ?? []) parts.push(`folder:${folder}`);
  for (const has of query.filters.has ?? []) parts.push(`has:${has}`);
  if (query.filters.after !== undefined) parts.push(`after:${new Date(query.filters.after).toISOString().slice(0, 10)}`);
  if (query.filters.before !== undefined) {
    parts.push(`before:${new Date(query.filters.before).toISOString().slice(0, 10)}`);
  }
  for (const term of query.filters.exclude ?? []) parts.push(`-${term}`);
  return parts.join(' ');
}
