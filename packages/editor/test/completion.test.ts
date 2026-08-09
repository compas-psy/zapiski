/**
 * Автодополнение тегов и wiki-ссылок (BEHAVIOR §2.4, §2.5).
 */

import { describe, expect, it } from 'vitest';
import { CompletionContext } from '@codemirror/autocomplete';
import type { CompletionResult } from '@codemirror/autocomplete';
import { tagCompletionSource, wikiCompletionSource } from '../src/completion/sources.js';
import { fuzzyScore, rankByFuzzy } from '../src/completion/fuzzy.js';
import { makeState } from './helpers.js';
import type { EditorRuntime } from '../src/runtime.js';

const TAGS = [
  { tag: 'практика', count: 42 },
  { tag: 'практика/супервизия', count: 17 },
  { tag: 'практикум', count: 3 },
  { tag: 'проза', count: 9 },
  { tag: 'путешествия', count: 1 },
  { tag: 'план', count: 2 },
  { tag: 'привычки', count: 5 },
  { tag: 'прогулки', count: 4 },
  { tag: 'проекты', count: 6 },
  { tag: 'пробы', count: 7 },
];

const NOTES = [
  { title: 'Супервизия', path: 'Работа/Супервизия.md' },
  { title: 'Супервизия — заметки', path: 'Работа/Супервизия — заметки.md' },
  { title: 'Сон и восстановление', path: 'Личное/Сон.md' },
  { title: 'Практика', path: 'Работа/Практика.md' },
];

function complete(
  doc: string,
  source: (ctx: CompletionContext) => CompletionResult | null,
  runtime: Partial<EditorRuntime> = {},
  pos = doc.length,
): CompletionResult | null {
  const state = makeState(doc, { runtime, selection: { anchor: pos } });
  return source(new CompletionContext(state, pos, true));
}

describe('автодополнение тегов', () => {
  const runtime = { tags: () => TAGS };

  it('не открывается на голой решётке', () => {
    expect(complete('#', tagCompletionSource, runtime)).toBeNull();
  });

  it('открывается на `#` + один символ', () => {
    const result = complete('#п', tagCompletionSource, runtime);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(0);
  });

  it('показывает не больше восьми совпадений', () => {
    const result = complete('#п', tagCompletionSource, runtime);
    expect(result?.options.length).toBe(8);
  });

  it('сортирует по частоте использования', () => {
    const result = complete('#пра', tagCompletionSource, runtime);
    expect(result?.options.map((o) => o.label)).toEqual([
      '#практика',
      '#практика/супервизия',
      '#практикум',
    ]);
  });

  it('вложенные теги показываются целиком', () => {
    const result = complete('#практика/', tagCompletionSource, runtime);
    expect(result?.options.some((o) => o.label === '#практика/супервизия')).toBe(true);
  });

  it('пробел завершает тег — validFor его не пропускает', () => {
    const result = complete('#пра', tagCompletionSource, runtime);
    expect((result?.validFor as RegExp).test('#пра ')).toBe(false);
  });

  it('внутри инлайн-кода подсказок нет', () => {
    expect(complete('`#пра`', tagCompletionSource, runtime, 5)).toBeNull();
  });

  it('внутри код-блока подсказок нет', () => {
    const doc = '```\n#пра\n```';
    expect(complete(doc, tagCompletionSource, runtime, 8)).toBeNull();
  });

  it('в заголовке `# ` тег не предлагается', () => {
    expect(complete('# ', tagCompletionSource, runtime)).toBeNull();
  });
});

describe('автодополнение wiki-ссылок', () => {
  const runtime = { notes: () => NOTES };

  it('открывается сразу на `[[`', () => {
    const result = complete('[[', wikiCompletionSource, runtime);
    expect(result).not.toBeNull();
    expect(result?.from).toBe(2);
  });

  it('первым идёт точное совпадение', () => {
    const result = complete('[[Супервизия', wikiCompletionSource, runtime);
    expect(result?.options[0]?.label).toBe('Супервизия');
  });

  it('fuzzy находит по подпоследовательности', () => {
    const result = complete('[[свст', wikiCompletionSource, runtime);
    expect(result?.options.map((o) => o.label)).toContain('Сон и восстановление');
  });

  it('не больше восьми результатов', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Заметка ${i}` }));
    const result = complete('[[Замет', wikiCompletionSource, { notes: () => many });
    expect(result?.options.length).toBe(8);
  });

  it('внутри инлайн-кода не открывается', () => {
    expect(complete('`[[Су`', wikiCompletionSource, runtime, 5)).toBeNull();
  });
});

describe('fuzzy-ранжирование', () => {
  it('точное совпадение весит больше префикса', () => {
    const exact = fuzzyScore('дом', 'дом') ?? 0;
    const prefix = fuzzyScore('дом', 'домовой') ?? 0;
    expect(exact).toBeGreaterThan(prefix);
  });

  it('ё и е не различаются', () => {
    expect(fuzzyScore('ёлка', 'елка')).not.toBeNull();
  });

  it('несовпадение даёт null', () => {
    expect(fuzzyScore('xyz', 'заметка')).toBeNull();
  });

  it('пустой запрос совпадает со всем', () => {
    expect(rankByFuzzy(NOTES, '', (n) => n.title, 8).length).toBe(NOTES.length);
  });
});
