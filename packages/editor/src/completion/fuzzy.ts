/**
 * Fuzzy-поиск по заголовкам заметок (BEHAVIOR §2.5).
 *
 * Правила ранжирования, ровно как в ТЗ:
 *   1) точное совпадение — всегда первым;
 *   2) затем совпадение с начала строки;
 *   3) затем совпадение по началу слова;
 *   4) затем подпоследовательность.
 * Внутри группы — короче заголовок, выше место.
 */

const EXACT = 4000;
const PREFIX = 3000;
const WORD_START = 2000;
const SUBSEQUENCE = 1000;

function normalize(text: string): string {
  // Приводим ё→е: пользователь почти никогда не набирает её в поиске.
  return text.toLowerCase().replace(/ё/g, 'е');
}

/**
 * Оценка совпадения. `null` — не совпало.
 * Пустой запрос совпадает со всем с нулевой оценкой.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalize(query.trim());
  const t = normalize(text);
  if (!q) return 0;
  if (q === t) return EXACT + (100 - Math.min(100, text.length));
  if (t.startsWith(q)) return PREFIX + (100 - Math.min(100, text.length));

  const wordStart = new RegExp(`(^|[\\s/_.,;:()\\[\\]«"'-])${escapeRegExp(q)}`, 'u');
  if (wordStart.test(t)) return WORD_START + (100 - Math.min(100, text.length));
  if (t.includes(q)) return WORD_START - 500 + (100 - Math.min(100, text.length));

  // Подпоследовательность: все символы запроса встречаются по порядку.
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return SUBSEQUENCE - Math.min(900, gaps);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Отсортировать и обрезать до `limit` (по ТЗ — 8). */
export function rankByFuzzy<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit: number,
): T[] {
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = fuzzyScore(query, key(item));
    if (score === null) continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || key(a.item).localeCompare(key(b.item), 'ru'));
  return scored.slice(0, limit).map((s) => s.item);
}
