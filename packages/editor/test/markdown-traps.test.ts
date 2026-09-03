/**
 * Ловушки Markdown: каждая команда в каждом окружении.
 *
 * ── Зачем матрица, а не список случаев ──────────────────────────────────────
 *
 * Заказчик поймал одну ловушку руками: маркерный список под абзацем превращал
 * абзац в заголовок. Ловушка не была экзотической — это setext-подчёркивание,
 * оно описано в CommonMark первой же главой про заголовки. Значит дело не в
 * редкости случая, а в том, что проверять было нечем: каждая команда
 * проверялась в пустом документе, где соседей нет.
 *
 * Здесь наоборот: команда прогоняется во ВСЕХ окружениях, какие бывают у
 * строки, и приговор выносит парсер — тот самый, которым рисуется живой показ
 * и которым файл прочтёт Obsidian.
 *
 * Правило одно и общее: команда обязана дать то, что обещает кнопкой, и не
 * имеет права переделать СОСЕДНИЕ строки. Второе важнее первого — испортить
 * чужой абзац хуже, чем не сделать свой список.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { StateCommand } from '@codemirror/state';

import {
  setHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleQuote,
  toggleTaskList,
} from '../src/commands/formatting.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function nodesOf(text: string): string[] {
  const probe = makeView(text, { selection: { anchor: 0 } });
  const names: string[] = [];
  syntaxTree(probe.state).iterate({ enter: (node) => void names.push(node.name) });
  probe.destroy();
  return names;
}

/** Что команда сделала с документом и как это прочитал парсер. */
function apply(doc: string, cursorLine: number, command: StateCommand): {
  text: string;
  nodes: string[];
  before: string[];
} {
  const before = nodesOf(doc);
  const probe = makeView(doc, { selection: { anchor: 0 } });
  const at = probe.state.doc.line(cursorLine).to;
  probe.destroy();

  view = makeView(doc, { selection: { anchor: at } });
  command(view);
  const text = view.state.doc.toString();
  const names: string[] = [];
  syntaxTree(view.state).iterate({ enter: (node) => void names.push(node.name) });
  return { text, nodes: names, before };
}

/**
 * Заголовки и линейки, которых в исходнике не было, — это порча соседей.
 *
 * `intended` вычитается: команда «заголовок» обязана создать заголовок, и
 * ставить ей это в вину — значит проверять не то. Первая редакция матрицы
 * ровно так и делала.
 */
function intruders(before: string[], after: string[], intended?: RegExp): string[] {
  const risky = (list: string[]): string[] =>
    list.filter((n) => /Heading|HorizontalRule/.test(n)).sort();
  const was = risky(before);
  const now = risky(after);
  const extra: string[] = [];
  const pool = [...was];
  for (const node of now) {
    const index = pool.indexOf(node);
    if (index !== -1) pool.splice(index, 1);
    else if (intended === undefined || !intended.test(node)) extra.push(node);
  }
  return extra;
}

/** Окружения, в которых человек нажимает кнопку. */
const CONTEXTS: ReadonlyArray<{ name: string; doc: string; line: number }> = [
  { name: 'пустой документ', doc: '', line: 1 },
  { name: 'под абзацем', doc: 'Слишком много выбора:\n', line: 2 },
  { name: 'под абзацем через пустую строку', doc: 'Абзац\n\n', line: 3 },
  { name: 'под пунктом списка', doc: '- первый\n', line: 2 },
  { name: 'под нумерованным пунктом', doc: '1. первый\n', line: 2 },
  { name: 'под цитатой', doc: '> цитата\n', line: 2 },
  { name: 'под заголовком', doc: '## Заголовок\n', line: 2 },
  { name: 'под строкой таблицы', doc: '| a | b |\n| - | - |\n', line: 3 },
  { name: 'между двумя абзацами', doc: 'Первый\n\nВторой', line: 2 },
  { name: 'на непустой строке под абзацем', doc: 'Абзац\nпункт', line: 2 },
];

const COMMANDS: ReadonlyArray<{ name: string; run: StateCommand; expect: RegExp }> = [
  { name: 'маркерный список', run: toggleBulletList, expect: /BulletList/ },
  { name: 'нумерованный список', run: toggleOrderedList, expect: /OrderedList/ },
  { name: 'список задач', run: toggleTaskList, expect: /BulletList/ },
  { name: 'цитата', run: toggleQuote, expect: /Blockquote/ },
  { name: 'заголовок H1', run: setHeading(1), expect: /ATXHeading1/ },
  { name: 'заголовок H3', run: setHeading(3), expect: /ATXHeading3/ },
];

describe('ни одна команда не переделывает соседние строки', () => {
  for (const command of COMMANDS) {
    for (const context of CONTEXTS) {
      it(`${command.name} — ${context.name}`, () => {
        const result = apply(context.doc, context.line, command.run);
        const extra = intruders(result.before, result.nodes, command.expect);
        expect(
          extra,
          `появилось из ниоткуда: ${extra.join(', ')}\nтекст стал:\n${result.text}`,
        ).toEqual([]);
      });
    }
  }
});

describe('команда делает то, что обещает кнопкой', () => {
  for (const command of COMMANDS) {
    /* Пустая строка под абзацем — тот самый случай из жалобы. */
    it(`${command.name} — под абзацем`, () => {
      const result = apply('Слишком много выбора:\n', 2, command.run);
      expect(
        result.nodes.some((n) => command.expect.test(n)),
        `не получилось: текст стал\n${result.text}`,
      ).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Тот же дефис, но набранный руками
// ─────────────────────────────────────────────────────────────────────────────

describe('дефис, набранный пальцем, тоже не делает заголовка', () => {
  /*
   * Заказчик пожаловался ДВАЖДЫ. Первый раз — на кнопку, и это починилось.
   * Второй раз — «ошибка не исчезла», и он был прав: кнопка не единственный
   * способ поставить дефис. Ещё в первом письме стояло прямо: «пришлось ещё
   * раз нажать Enter, чтобы при наборе "-" текст не укрупнялся».
   *
   * Проверка идёт через настоящий ввод (`inputHandler`), а не через команду:
   * иначе она проверяла бы уже починенный путь и молчала о втором.
   */
  function typeChar(doc: string, at: number, char: string): EditorView {
    view = makeView(doc, { selection: { anchor: at } });
    /* Так же, как это делает CodeMirror при наборе: сперва спрашиваем
       обработчики ввода, и только если никто не взял — вставляем сами. */
    const handled = view.state.facet(EditorView.inputHandler).some(
      (handler) => handler(view as EditorView, at, at, char, () => null as never) === true,
    );
    if (!handled) view.dispatch({ changes: { from: at, insert: char } });
    return view;
  }

  it('под абзацем ставит пустую строку сам', () => {
    const v = typeChar('Слишком много выбора:\n', 22, '-');
    expect(v.state.doc.toString()).toBe('Слишком много выбора:\n\n-');
  });

  it('и парсер заголовка больше не видит', () => {
    const v = typeChar('Слишком много выбора:\n', 22, '-');
    const names: string[] = [];
    syntaxTree(v.state).iterate({ enter: (node) => void names.push(node.name) });
    expect(names.filter((n) => /Heading/.test(n)), 'абзац снова стал заголовком').toEqual([]);
  });

  it('внутри списка не вмешивается', () => {
    const v = typeChar('- первый\n', 9, '-');
    expect(v.state.doc.toString()).toBe('- первый\n-');
  });

  it('после пустой строки не вмешивается', () => {
    const v = typeChar('Абзац\n\n', 7, '-');
    expect(v.state.doc.toString()).toBe('Абзац\n\n-');
  });

  it('дефис внутри слова не трогает', () => {
    const v = typeChar('Абзац\nкто', 9, '-');
    expect(v.state.doc.toString()).toBe('Абзац\nкто-');
  });

  it('курсор остаётся за набранным символом', () => {
    const v = typeChar('Слишком много выбора:\n', 22, '-');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
  });
});

describe('«=», набранный пальцем, тоже не делает заголовка (P1-аудит)', () => {
  /*
   * `-` был защищён с самого начала, а `=` — единственный другой символ,
   * из которого строится Setext-заголовок (H1), — этой же защиты не имел
   * вовсе: набор «====» под абзацем молча укрупнял его в H1, без единого
   * нажатия Enter, которое хотя бы предупредило.
   */
  function typeChar(doc: string, at: number, char: string): EditorView {
    view = makeView(doc, { selection: { anchor: at } });
    const handled = view.state.facet(EditorView.inputHandler).some(
      (handler) => handler(view as EditorView, at, at, char, () => null as never) === true,
    );
    if (!handled) view.dispatch({ changes: { from: at, insert: char } });
    return view;
  }

  it('под абзацем ставит пустую строку сам', () => {
    const v = typeChar('Слишком много выбора:\n', 22, '=');
    expect(v.state.doc.toString()).toBe('Слишком много выбора:\n\n=');
  });

  it('и парсер заголовка больше не видит', () => {
    const v = typeChar('Слишком много выбора:\n', 22, '=');
    const names: string[] = [];
    syntaxTree(v.state).iterate({ enter: (node) => void names.push(node.name) });
    expect(names.filter((n) => /Heading/.test(n)), 'абзац снова стал заголовком').toEqual([]);
  });

  it('после пустой строки не вмешивается', () => {
    const v = typeChar('Абзац\n\n', 7, '=');
    expect(v.state.doc.toString()).toBe('Абзац\n\n=');
  });

  it('внутри слова не трогает', () => {
    const v = typeChar('Абзац\nA', 7, '=');
    expect(v.state.doc.toString()).toBe('Абзац\nA=');
  });
});
