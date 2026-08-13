/**
 * Таблица выравнивается сама, когда курсор из неё уходит.
 *
 * Дефект заказчика: «таблица капут при вводе». Воспроизводится с первого
 * символа — markdown держит колонки пробелами, и дописанное слово делает
 * строку длиннее остальных: палки разъезжаются, вместо таблицы лесенка.
 *
 * Проверяется здесь ровно граница поведения: пока курсор внутри — документ не
 * трогаем (иначе правка дерётся с IME, см. `ime/composition.ts`), вышел —
 * таблица встала ровно.
 */
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

const TABLE = ['| Дело   | Срок |', '| ------ | ---- |', '| созвон | пн   |', '', 'Хвост.'].join(
  '\n',
);

/** Микрозадача: выравнивание диспатчится после обновления, а не внутри него. */
const settled = (): Promise<void> => new Promise((done) => queueMicrotask(() => done()));

describe('таблица встаёт ровно сама', () => {
  it('пока курсор внутри — текст не трогаем', async () => {
    const v = makeView(TABLE, { selection: { anchor: TABLE.indexOf('созвон') + 6 } });
    view = v;
    v.dispatch({ changes: { from: TABLE.indexOf('созвон') + 6, insert: ' в среду' } });
    await settled();
    /*
     * Строки РАЗНОЙ длины — и это правильно: выровнять их сейчас значит
     * переписать ту самую строку, в которой идёт ввод.
     *
     * Проверяется именно разнобой, а не «строка на месте»: строка, которую
     * правят, самая длинная, и от выравнивания она не меняется. Утверждение
     * про неё прошло бы и с выключённым сторожем — то есть не проверяло бы
     * ничего.
     */
    const widths = v.state.doc.toString().split('\n').slice(0, 3).map((line) => line.length);
    expect(
      new Set(widths).size,
      `таблицу выровняли под курсором: ${widths.join(', ')}`,
    ).toBeGreaterThan(1);
  });

  it('курсор ушёл — колонки выровнялись', async () => {
    const v = makeView(TABLE, { selection: { anchor: TABLE.indexOf('созвон') + 6 } });
    view = v;
    v.dispatch({ changes: { from: TABLE.indexOf('созвон') + 6, insert: ' в среду' } });
    await settled();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    await settled();

    const lines = v.state.doc.toString().split('\n').slice(0, 3);
    const widths = lines.map((line) => line.length);
    expect(new Set(widths).size, `строки разной длины: ${widths.join(', ')}`).toBe(1);
    expect(lines[0]).toContain('Дело');
  });

  it('ровную таблицу не переписываем: лишней правки в истории быть не должно', async () => {
    const v = makeView(TABLE, { selection: { anchor: TABLE.indexOf('созвон') + 2 } });
    view = v;
    const before = v.state.doc.toString();
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    await settled();
    expect(v.state.doc.toString()).toBe(before);
  });

  it('текст вне таблицы не трогаем вовсе', async () => {
    const doc = 'Просто абзац с палкой | внутри.\n\nВторой абзац.';
    const v = makeView(doc, { selection: { anchor: 5 } });
    view = v;
    v.dispatch({ selection: { anchor: doc.length } });
    await settled();
    expect(v.state.doc.toString()).toBe(doc);
  });
});
