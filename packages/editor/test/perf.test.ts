/**
 * Перф-бюджеты редактора (ТЗ §5.1, ARCHITECTURE §4).
 *
 * | Бюджет                                  |
 * | Ввод <16 мс на кейстрок в заметке 1 МБ  |
 * | Открытие заметки <150 мс                |
 *
 * Меряем ровно ту работу, которую редактор делает на кейстрок:
 * транзакция состояния (включая инкрементальный доразбор markdown) плюс
 * пересборка декораций live-preview. DOM в замер не входит намеренно: в
 * jsdom его геометрия — фикция, а бюджет должен ловить регрессии нашего
 * кода, а не скорость чужого layout.
 *
 * Ключ к бюджету — вьюпорт: декорации строятся только по видимым диапазонам.
 * Если кто-то однажды уберёт это ограничение, тест упадёт сразу.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { zapiskiEditor } from '../src/setup.js';
import { noopRuntime } from '../src/runtime.js';
import { buildLivePreview } from '../src/live-preview/decorations.js';

/** Экран текста в редакторе — примерно столько символов держит вьюпорт. */
const VIEWPORT = 8_000;
const MB = 1024 * 1024;

/** Заметка 1 МБ из всех элементов витринной заметки (SCREENS §4). */
function bigNote(bytes: number): string {
  const block = [
    '## Раздел про практику',
    '',
    'Обычный абзац с **жирным**, *курсивом*, ==подсветкой== и `кодом`.',
    'Ещё строка с [[wiki-ссылкой]], [обычной ссылкой](https://example.org) и #тегом.',
    '',
    '- [ ] невыполненная задача',
    '- [x] выполненная задача',
    '- обычный пункт списка',
    '',
    '> Цитата в две строки,',
    '> продолжение цитаты.',
    '',
    '| Колонка | Значение |',
    '| --- | --- |',
    '| раз | два |',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
  ].join('\n');
  const repeats = Math.ceil(bytes / block.length);
  return block.repeat(repeats).slice(0, bytes);
}

function makeBigState(doc: string): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: zapiskiEditor({ runtime: noopRuntime }),
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[index] ?? 0;
}

describe('перф-бюджеты (ARCHITECTURE §4)', () => {
  const doc = bigNote(MB);

  it('документ действительно весит около мегабайта', () => {
    expect(doc.length).toBe(MB);
  });

  it('открытие заметки 1 МБ — меньше 150 мс', () => {
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const state = makeBigState(doc);
      // Разбираем только то, что попадёт на экран, — как делает живой редактор.
      ensureSyntaxTree(state, VIEWPORT, 120);
      buildLivePreview(state, [{ from: 0, to: VIEWPORT }]);
      runs.push(performance.now() - started);
    }
    // Проверяем ХУДШИЙ прогон, включая самый первый, «холодный».
    const worst = Math.max(...runs);
    // eslint-disable-next-line no-console
    console.log(
      `открытие заметки 1 МБ: худший ${worst.toFixed(1)} мс · медиана ${percentile(runs, 0.5).toFixed(1)} мс` +
        ` (прогоны: ${runs.map((r) => r.toFixed(1)).join(', ')})`,
    );
    expect(worst).toBeLessThan(150);
  });

  it('кейстрок в заметке 1 МБ — меньше 16 мс', () => {
    let state = makeBigState(doc);
    ensureSyntaxTree(state, VIEWPORT, 200);

    // Печатаем в середине первого экрана — там, где живёт курсор.
    let at = Math.floor(VIEWPORT / 2);
    const timings: number[] = [];

    // Прогрев: JIT и первый разбор не должны попасть в статистику.
    for (let i = 0; i < 30; i++) {
      state = state.update({ changes: { from: at, insert: 'ы' }, selection: { anchor: at + 1 } }).state;
      at += 1;
      buildLivePreview(state, [{ from: at - VIEWPORT / 2, to: at + VIEWPORT / 2 }]);
    }

    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      state = state.update({
        changes: { from: at, insert: 'ы' },
        selection: { anchor: at + 1 },
      }).state;
      at += 1;
      buildLivePreview(state, [
        { from: Math.max(0, at - VIEWPORT / 2), to: Math.min(state.doc.length, at + VIEWPORT / 2) },
      ]);
      timings.push(performance.now() - started);
    }

    const median = percentile(timings, 0.5);
    const p95 = percentile(timings, 0.95);
    const worst = Math.max(...timings);
    // eslint-disable-next-line no-console
    console.log(
      `кейстрок 1 МБ: медиана ${median.toFixed(2)} мс · p95 ${p95.toFixed(2)} мс · максимум ${worst.toFixed(2)} мс`,
    );
    expect(p95).toBeLessThan(16);
  });

  it('перемещение курсора пересобирает декорации быстрее кейстрока', () => {
    let state = makeBigState(doc);
    ensureSyntaxTree(state, VIEWPORT, 200);
    const timings: number[] = [];
    for (let i = 0; i < 200; i++) {
      const anchor = 100 + i * 7;
      const started = performance.now();
      state = state.update({ selection: { anchor } }).state;
      buildLivePreview(state, [{ from: 0, to: VIEWPORT }]);
      timings.push(performance.now() - started);
    }
    const p95 = percentile(timings, 0.95);
    // eslint-disable-next-line no-console
    console.log(`движение курсора: p95 ${p95.toFixed(2)} мс`);
    expect(p95).toBeLessThan(16);
  });

  it('стоимость не зависит от размера документа — только от вьюпорта', () => {
    const measure = (text: string): number => {
      const state = makeBigState(text);
      ensureSyntaxTree(state, Math.min(VIEWPORT, text.length), 200);
      const runs: number[] = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        buildLivePreview(state, [{ from: 0, to: Math.min(VIEWPORT, text.length) }]);
        runs.push(performance.now() - started);
      }
      return percentile(runs, 0.5);
    };

    const small = measure(bigNote(20_000));
    const large = measure(doc);
    // eslint-disable-next-line no-console
    console.log(`декорации: 20 КБ ${small.toFixed(2)} мс · 1 МБ ${large.toFixed(2)} мс`);
    // Разброс в разы допустим (кэши, GC), в десятки — нет: это означало бы,
    // что декорации считаются по всему документу.
    expect(large).toBeLessThan(Math.max(small * 4, 4));
  });
});
