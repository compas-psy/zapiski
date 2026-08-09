/**
 * Построчный three-way merge (diff3) — запасной путь синка, когда у
 * контрагента нет CRDT-лога: «правили чужим редактором» (ТЗ §4.2).
 *
 * При неразрешимости обе версии сохраняются, «чужая» уходит в `versions/` —
 * поэтому здесь конфликт не помечается маркерами `<<<<<<<`, а честно
 * возвращается как `ok: false`. Пользователь никогда не видит мусор в тексте.
 */

/** Ограничение размера: на больших файлах O(n·m) LCS не оправдан. */
const MAX_LINES = 5000;

export interface Diff3Result {
  ok: boolean;
  text: string;
  conflicts: number;
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * Для каждой строки `a` — индекс соответствующей строки в `b` по наибольшей
 * общей подпоследовательности, либо -1.
 */
function alignByLcs(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? (table[at(i + 1, j + 1)] as number) + 1
          : Math.max(table[at(i + 1, j)] as number, table[at(i, j + 1)] as number);
    }
  }
  const map = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      map[i] = j;
      i += 1;
      j += 1;
    } else if ((table[at(i + 1, j)] as number) >= (table[at(i, j + 1)] as number)) i += 1;
    else j += 1;
  }
  return map;
}

function sameChunk(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export function diff3(base: string, mine: string, theirs: string): Diff3Result {
  if (mine === theirs) return { ok: true, text: mine, conflicts: 0 };
  if (base === mine) return { ok: true, text: theirs, conflicts: 0 };
  if (base === theirs) return { ok: true, text: mine, conflicts: 0 };

  const baseLines = splitLines(base);
  const mineLines = splitLines(mine);
  const theirLines = splitLines(theirs);
  if (baseLines.length > MAX_LINES || mineLines.length > MAX_LINES || theirLines.length > MAX_LINES) {
    return { ok: false, text: mine, conflicts: 1 };
  }

  const toMine = alignByLcs(baseLines, mineLines);
  const toTheirs = alignByLcs(baseLines, theirLines);

  const out: string[] = [];
  let conflicts = 0;
  let baseCursor = 0;
  let mineCursor = 0;
  let theirCursor = 0;

  const emitRegion = (baseEnd: number, mineEnd: number, theirEnd: number): void => {
    const baseChunk = baseLines.slice(baseCursor, baseEnd);
    const mineChunk = mineLines.slice(mineCursor, mineEnd);
    const theirChunk = theirLines.slice(theirCursor, theirEnd);
    if (sameChunk(mineChunk, theirChunk)) out.push(...mineChunk);
    else if (sameChunk(mineChunk, baseChunk)) out.push(...theirChunk);
    else if (sameChunk(theirChunk, baseChunk)) out.push(...mineChunk);
    else {
      // Обе стороны правили одно место по-разному — неразрешимо построчно.
      conflicts += 1;
      out.push(...mineChunk);
    }
  };

  for (let i = 0; i < baseLines.length; i += 1) {
    const mineIndex = toMine[i] as number;
    const theirIndex = toTheirs[i] as number;
    if (mineIndex === -1 || theirIndex === -1) continue;
    emitRegion(i, mineIndex, theirIndex);
    out.push(baseLines[i] as string);
    baseCursor = i + 1;
    mineCursor = mineIndex + 1;
    theirCursor = theirIndex + 1;
  }
  emitRegion(baseLines.length, mineLines.length, theirLines.length);

  return { ok: conflicts === 0, text: out.join('\n'), conflicts };
}
