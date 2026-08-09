/**
 * Перф-бюджеты (ТЗ §6, ARCHITECTURE §4) — автотесты, а не пожелания:
 *  • FTS <50 мс на корпусе 10 000 заметок;
 *  • открытие заметки <150 мс.
 *
 * Замер идёт на медиане нескольких прогонов: одиночный выброс планировщика не
 * должен красить CI в красный, а регрессия в разы — обязана.
 *
 * Бюджеты меряются БЕЗ инструментирования покрытия (v8-coverage добавляет к
 * разбору заметки 1 МБ втрое) — поэтому `test:coverage` этот файл исключает,
 * а `pnpm test` гоняет его в полном объёме.
 */
import { describe, expect, it } from 'vitest';
import type { Note } from '../src/contract.js';
import { InvertedIndex } from '../src/index/note-index.js';
import { parseQuery } from '../src/index/query.js';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { parseNote } from '../src/markdown/parse.js';

const CORPUS = 10_000;
const FTS_BUDGET_MS = 50;
const OPEN_BUDGET_MS = 150;

const WORDS = [
  'супервизия', 'практика', 'клиент', 'встреча', 'заметка', 'проект', 'идея', 'разбор',
  'случай', 'терапия', 'группа', 'договор', 'отчёт', 'план', 'вопрос', 'ответ',
  'ёлка', 'дача', 'дневник', 'мысль', 'наблюдение', 'вывод', 'гипотеза', 'решение',
];

/** Детерминированный генератор — корпус одинаков от запуска к запуску. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function buildCorpus(size: number): Note[] {
  const random = makeRandom(42);
  const notes: Note[] = [];
  for (let i = 0; i < size; i += 1) {
    const words: string[] = [];
    for (let w = 0; w < 120; w += 1) words.push(WORDS[Math.floor(random() * WORDS.length)] as string);
    const folder = `Папка ${i % 20}`;
    const body = `# Заметка ${i} ${WORDS[i % WORDS.length]}\n\n${words.join(' ')}\n\n#тег/${i % 30}\n`;
    const parsed = parseNote(body);
    notes.push({
      id: `n${i}`,
      path: `${folder}/Заметка ${i}.md`,
      title: parsed.title,
      snippet: parsed.snippet,
      createdAt: 1_700_000_000_000 + i * 1000,
      updatedAt: 1_700_000_000_000 + i * 1000,
      pinned: false,
      archived: false,
      tags: parsed.tags,
      encrypted: false,
      hasImage: false,
      hasFile: false,
      hasTodo: false,
      hasLink: false,
      wordCount: parsed.wordCount,
      body,
    });
  }
  return notes;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function measure(runs: number, action: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    action();
    times.push(performance.now() - start);
  }
  return median(times);
}

describe('перф-бюджеты (ТЗ §6)', () => {
  const notes = buildCorpus(CORPUS);
  const index = new InvertedIndex();
  index.rebuild(notes);

  it(`корпус построен: ${CORPUS} заметок`, () => {
    expect(index.all()).toHaveLength(CORPUS);
  });

  it(`FTS по слову — медиана <${FTS_BUDGET_MS} мс`, () => {
    const elapsed = measure(11, () => {
      const hits = index.search(parseQuery('гипотеза'), 200);
      expect(hits.length).toBeGreaterThan(0);
    });
    // eslint-disable-next-line no-console
    console.log(`FTS «гипотеза» на ${CORPUS} заметках: ${elapsed.toFixed(1)} мс`);
    expect(elapsed).toBeLessThan(FTS_BUDGET_MS);
  });

  it(`FTS с операторами и фразой — медиана <${FTS_BUDGET_MS} мс`, () => {
    const elapsed = measure(11, () => {
      index.search(parseQuery('разбор случая tag:тег/3 folder:Папка 3 has:todo -ёлка'), 200);
    });
    // eslint-disable-next-line no-console
    console.log(`FTS с операторами на ${CORPUS} заметках: ${elapsed.toFixed(1)} мс`);
    expect(elapsed).toBeLessThan(FTS_BUDGET_MS);
  });

  it(`FTS по точной фразе — медиана <${FTS_BUDGET_MS} мс`, () => {
    const elapsed = measure(11, () => {
      index.search(parseQuery('"супервизия практика"'), 200);
    });
    // eslint-disable-next-line no-console
    console.log(`FTS по фразе на ${CORPUS} заметках: ${elapsed.toFixed(1)} мс`);
    expect(elapsed).toBeLessThan(FTS_BUDGET_MS);
  });

  it(`открытие заметки — <${OPEN_BUDGET_MS} мс на заметке 1 МБ`, async () => {
    const big = `# Большая заметка\n\n${'слово '.repeat(180_000)}`;
    const storage = new MemoryVaultStorage({ files: { 'Большая заметка.md': big } });
    const vault = await Vault.open(storage, { renameDelayMs: 0 });

    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const start = performance.now();
      const note = await vault.read('Большая заметка.md');
      times.push(performance.now() - start);
      expect(note?.title).toBe('Большая заметка');
    }
    const elapsed = median(times);
    // eslint-disable-next-line no-console
    console.log(`Открытие заметки ${(big.length / 1024 / 1024).toFixed(2)} МБ: ${elapsed.toFixed(1)} мс`);
    expect(elapsed).toBeLessThan(OPEN_BUDGET_MS);
  });

  it('backlinks на большом корпусе отвечают быстро', () => {
    const elapsed = measure(11, () => {
      index.backlinks('n500');
    });
    expect(elapsed).toBeLessThan(FTS_BUDGET_MS);
  });
});
