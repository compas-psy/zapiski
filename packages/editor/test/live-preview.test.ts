/**
 * Приёмочный критерий редактора (BEHAVIOR §2.1, §13.3):
 * символы разметки всегда занимают место, меняется только opacity,
 * layout не сдвигается никогда.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decorationsOf, makeState } from './helpers.js';

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...srcFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('LAYOUT НЕ СДВИГАЕТСЯ (BEHAVIOR §2.1, приёмочный критерий №3)', () => {
  it('во всём пакете нет ни одного Decoration.replace', () => {
    const stripComments = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const files = srcFiles(join(dirname(fileURLToPath(import.meta.url)), '..', 'src'));
    const guilty = files.filter((f) =>
      /Decoration\.replace/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(guilty).toEqual([]);
  });

  it('ни одна декорация с длиной > 0 не является заменяющей', () => {
    const doc = '# Заголовок\n\nТекст **жирный** и *курсив* и ==подсветка==.\n\n> Цитата\n';
    for (const d of decorationsOf(makeState(doc))) {
      if (d.to > d.from) {
        // Диапазонная декорация обязана быть mark-декорацией с классом:
        // replace-декорация класса не имеет, она заменяет содержимое.
        expect(d.class, `декорация ${d.from}..${d.to} должна быть mark`).toBeTruthy();
        expect(d.widget).toBeNull();
      }
    }
  });

  it('вход курсора в узел меняет ТОЛЬКО класс, диапазоны остаются теми же', () => {
    const doc = 'Текст **жирный** дальше.';
    const boldFrom = doc.indexOf('**');
    const outside = decorationsOf(makeState(doc, { selection: { anchor: 0 } }));
    const inside = decorationsOf(
      makeState(doc, { selection: { anchor: boldFrom + 4 } }),
    );

    expect(inside.map((d) => [d.from, d.to])).toEqual(outside.map((d) => [d.from, d.to]));

    const changed = inside.filter((d, i) => d.class !== outside[i]?.class);
    expect(changed.length).toBeGreaterThan(0);
    for (const d of changed) {
      // Разница строго в добавлении модификатора непрозрачности.
      expect(d.class).toBe('cm-z-mark cm-z-mark-on');
    }
  });

  it('символы разметки получают класс cm-z-mark и вне активного узла, и внутри', () => {
    const doc = 'Текст **жирный** дальше.';
    const from = doc.indexOf('**');
    const far = decorationsOf(makeState(doc, { selection: { anchor: 0 } }));
    const open = far.find((d) => d.from === from && d.to === from + 2);
    expect(open?.class).toBe('cm-z-mark');
  });

  it('курсор, примыкающий к границе узла, тоже считается внутри', () => {
    const doc = 'Текст **жирный** дальше.';
    const end = doc.indexOf('** дальше') + 2;
    const decos = decorationsOf(makeState(doc, { selection: { anchor: end } }));
    const closing = decos.find((d) => d.from === end - 2 && d.to === end);
    expect(closing?.class).toBe('cm-z-mark cm-z-mark-on');
  });

  it('выделение, накрывающее узел, проявляет его разметку', () => {
    const doc = 'Текст **жирный** дальше.';
    const decos = decorationsOf(
      makeState(doc, { selection: { anchor: 0, head: doc.length } }),
    );
    const marks = decos.filter((d) => d.class?.startsWith('cm-z-mark'));
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((d) => d.class === 'cm-z-mark cm-z-mark-on')).toBe(true);
  });
});

describe('стилизация элементов (DESIGN_TOKENS §2, SCREENS §4)', () => {
  const classesFor = (doc: string, needle: string): string[] => {
    const state = makeState(doc, { selection: { anchor: 0 } });
    return decorationsOf(state)
      .filter((d) => d.class?.includes(needle))
      .map((d) => d.class ?? '');
  };

  it('H1–H6 получают разные классы — размер и насыщенность, не цвет', () => {
    for (let level = 1; level <= 6; level++) {
      const doc = `${'#'.repeat(level)} Заголовок`;
      expect(classesFor(doc, `cm-z-h${level}`).length).toBe(1);
    }
  });

  it('жирный, курсив, зачёркнутый и подсветка', () => {
    expect(classesFor('**ж**', 'cm-z-strong').length).toBe(1);
    expect(classesFor('*к*', 'cm-z-em').length).toBe(1);
    expect(classesFor('~~з~~', 'cm-z-strike').length).toBe(1);
    expect(classesFor('==п==', 'cm-z-highlight').length).toBe(1);
  });

  it('маркеры списка — акцентные и не фейдятся', () => {
    const marks = classesFor('- пункт', 'cm-z-list-mark');
    expect(marks).toEqual(['cm-z-list-mark']);
  });

  it('цитата, код-блок, разделитель и таблица — построчные декорации', () => {
    expect(classesFor('> цитата', 'cm-z-quote').length).toBe(1);
    const code = classesFor('```js\nlet a = 1;\n```', 'cm-z-code').filter(
      (c) => !c.includes('cm-z-code-info'),
    );
    expect(code.length).toBe(3);
    expect(code[0]).toContain('cm-z-code-first');
    expect(code[2]).toContain('cm-z-code-last');
    expect(classesFor('\n---\n', 'cm-z-hr').length).toBe(1);
    const table = classesFor('| а | б |\n| --- | --- |\n| 1 | 2 |', 'cm-z-table');
    expect(table.some((c) => c.includes('cm-z-table-head'))).toBe(true);
    expect(table.some((c) => c.includes('cm-z-table-last'))).toBe(true);
  });

  it('ссылка получает акцент, url — приглушённый моно', () => {
    const doc = '[текст](https://example.org)';
    expect(classesFor(doc, 'cm-z-link').length).toBeGreaterThan(0);
    expect(classesFor(doc, 'cm-z-url').length).toBe(1);
  });

  it('сноска и её определение', () => {
    expect(classesFor('Текст[^1].', 'cm-z-footnote').length).toBe(1);
    expect(classesFor('[^1]: пояснение', 'cm-z-footnote-def').length).toBe(1);
  });
});

describe('wiki-ссылки и теги', () => {
  it('существующая ссылка — акцент без пунктирной прозрачности', () => {
    const state = makeState('Смотри [[Практика]] дальше.', {
      runtime: { wikiExists: (t) => t === 'Практика' },
      selection: { anchor: 0 },
    });
    const wiki = decorationsOf(state).find((d) => d.class?.includes('cm-z-wiki'));
    expect(wiki?.class).toBe('cm-z-wiki');
  });

  it('висячая ссылка — акцент + пунктир 50% (BEHAVIOR §2.5)', () => {
    const state = makeState('Смотри [[Ничего]] дальше.', {
      runtime: { wikiExists: () => false },
      selection: { anchor: 0 },
    });
    const wiki = decorationsOf(state).find((d) => d.class?.includes('cm-z-wiki'));
    expect(wiki?.class).toBe('cm-z-wiki cm-z-wiki-dangling');
  });

  it('алиас `[[цель|подпись]]` резолвится по цели', () => {
    const seen: string[] = [];
    const state = makeState('[[Цель|подпись]]', {
      runtime: {
        wikiExists: (t) => {
          seen.push(t);
          return true;
        },
      },
      selection: { anchor: 0 },
    });
    decorationsOf(state);
    expect(seen).toContain('Цель');
  });

  it('вложенный тег распознаётся целиком', () => {
    const doc = 'Заметка #практика/супервизия дальше';
    const state = makeState(doc, { selection: { anchor: 0 } });
    const tag = decorationsOf(state).find((d) => d.class === 'cm-z-tag');
    expect(tag).toBeDefined();
    expect(doc.slice(tag?.from ?? 0, tag?.to ?? 0)).toBe('#практика/супервизия');
  });

  it('решётка заголовка тегом не считается', () => {
    const state = makeState('# Заголовок', { selection: { anchor: 0 } });
    expect(decorationsOf(state).some((d) => d.class === 'cm-z-tag')).toBe(false);
  });
});

describe('чекбоксы и картинки — виджеты, а не замены', () => {
  it('у чекбокса появляется виджет-квадрат и mark на сырых скобках', () => {
    const state = makeState('- [ ] задача', { selection: { anchor: 0 } });
    const decos = decorationsOf(state);
    const widget = decos.find((d) => d.widget === 'TaskBoxWidget');
    expect(widget).toBeDefined();
    expect(widget?.from).toBe(widget?.to);
    expect(decos.some((d) => d.class?.includes('cm-z-task'))).toBe(true);
  });

  it('отмеченная задача получает line-through на тексте', () => {
    const state = makeState('- [x] сделано', { selection: { anchor: 0 } });
    expect(decorationsOf(state).some((d) => d.class === 'cm-z-task-done')).toBe(true);
  });

  it('картинка рендерится добавочным виджетом в конце строки', () => {
    const state = makeState('![кот](attachments/2026-08-09_ab.png)', {
      runtime: { resolveAttachment: (src) => `blob:${src}` },
      selection: { anchor: 0 },
    });
    const image = decorationsOf(state).find((d) => d.widget === 'ImageWidget');
    expect(image).toBeDefined();
    expect(image?.from).toBe(image?.to);
  });

  it('нерезолвящееся вложение виджета не создаёт', () => {
    const state = makeState('![кот](attachments/нет.png)', {
      runtime: { resolveAttachment: () => null },
      selection: { anchor: 0 },
    });
    expect(decorationsOf(state).some((d) => d.widget === 'ImageWidget')).toBe(false);
  });
});
