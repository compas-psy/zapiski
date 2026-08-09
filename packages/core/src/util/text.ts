/**
 * Текстовые утилиты: нормализация и токенизация для индекса (ADR-0002).
 * Стемминга нет осознанно — для заметок точное совпадение предсказуемее.
 */

/** Нормализация: нижний регистр + `ё → е` (ADR-0002). */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

export interface Token {
  /** Нормализованный терм. */
  term: string;
  /** Смещение начала в исходной строке — нужно для фрагментов подсветки. */
  start: number;
  end: number;
}

/**
 * Токенизация: буквы (латиница + кириллица), цифры и подчёркивание.
 * Дефис разбивает слово — «пиши-сокращай» даёт два терма и фразу.
 */
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = TOKEN_RE.exec(text);
  while (match !== null) {
    out.push({
      term: normalizeText(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
    match = TOKEN_RE.exec(text);
  }
  return out;
}

export function tokenTerms(text: string): string[] {
  return tokenize(text).map((t) => t.term);
}

/** Экранирование для построения RegExp из пользовательского ввода. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Подсчёт слов для панели «Инфо» (BEHAVIOR §2.9). */
export function countWords(text: string): number {
  return tokenize(text).length;
}

/** Обрезка по границе слова — для сниппета в строке списка. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/** `2026-08-08` из timestamp — для имён вложений (ТЗ §3.2). */
export function isoDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
