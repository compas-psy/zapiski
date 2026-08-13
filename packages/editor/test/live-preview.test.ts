/**
 * Поведение разметки у курсора — главный приёмочный критерий редактора.
 *
 * ПРЕЖНИЙ КОНТРАКТ ОТМЕНЁН. Раньше здесь проверялось, что символы разметки
 * всегда занимают место в потоке и меняется только `opacity`, а
 * `Decoration.replace` не встречается ни разу. Формально это выполнялось,
 * а на живом устройстве заказчик увидел: «убирает `**`, но оставляет 2
 * пробела, как будто эти символы ещё там». Они там и оставались — невидимые,
 * но занимающие место, — и вдобавок служили местом, куда встаёт курсор:
 * после Ctrl+B по выделению всё напечатанное дальше уезжало ВНУТРЬ жирного.
 *
 * Новый контракт: вне активного узла символы схлопнуты и неделимы для
 * курсора; внутри — показаны классом `cm-z-mark cm-z-mark-on`.
 */

import { describe, expect, it } from 'vitest';
import { decorationsOf, hiddenRanges, makeState } from './helpers.js';

describe('разметка схлопывается вне курсора и проявляется внутри', () => {
  it('вне активного узла символов нет в потоке — ни одной дыры', () => {
    const doc = 'Текст **жирный** дальше.';
    const decos = decorationsOf(makeState(doc, { selection: { anchor: 0 } }));
    const visible = decos.filter((d) => d.class?.startsWith('cm-z-mark'));
    expect(visible).toEqual([]);
  });

  it('внутри узла символы показаны и занимают ровно свои границы', () => {
    const doc = 'Текст **жирный** дальше.';
    const from = doc.indexOf('**');
    const decos = decorationsOf(makeState(doc, { selection: { anchor: from + 4 } }));
    const open = decos.find((d) => d.from === from && d.to === from + 2);
    expect(open?.class).toBe('cm-z-mark cm-z-mark-on');
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
    const decos = decorationsOf(makeState(doc, { selection: { anchor: 0, head: doc.length } }));
    const marks = decos.filter((d) => d.class?.startsWith('cm-z-mark'));
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((d) => d.class === 'cm-z-mark cm-z-mark-on')).toBe(true);
  });

  /* Курсор ставится ЗАВЕДОМО вне узла. Для строчных маркеров (`#`, `>`) это
     соседняя строка: узел начинается в позиции 0, и курсор в начале документа
     к нему примыкает — то есть считается активным. Прежняя редакция теста
     ставила курсор в конец строки и по той же причине проверяла проявленное
     состояние под видом скрытого. */
  /* Последнее число — сколько символов должно схлопнуться. У БЛОЧНЫХ маркеров
     (`#`, `>`) это на один больше самого символа: вместе с ними прячется
     пробел, отделяющий их от текста. Иначе заголовок остаётся сдвинут на
     символ вправо относительно обычного текста — заказчик описал это как
     «при применении Hx остаётся пробел перед словом». Пробел здесь часть
     разметки: без него `#Заголовок` вообще не заголовок. */
  it.each([
    ['заголовок', '# Заголовок\n\nдалее', '#', 0, 15, 2],
    ['цитата', '> Цитата\n\nдалее', '>', 0, 12, 2],
    ['жирный', 'а **ж** б', '**', 2, 0, 2],
    ['подсветка', 'а ==п== б', '==', 2, 0, 2],
    ['wiki', 'а [[Цель]] б', '[[', 2, 0, 2],
    ['код', 'а `код` б', '`', 2, 0, 1],
    ['ссылка', 'а [т](u) б', '[', 2, 0, 1],
  ])('символ разметки %s схлопывается, когда курсор далеко', (_name, doc, mark, at, cursor, length) => {
    const state = makeState(doc, { selection: { anchor: cursor } });
    const hidden = hiddenRanges(state);
    const found = hidden.find((r) => r.from === at && r.to === at + length);
    expect(found, `символ «${mark}» в «${doc}» не схлопнут вместе с отбивкой`).toBeDefined();
  });

  it('схлопнутое неделимо для курсора: пара перешагивается целиком', () => {
    const doc = 'Текст **жирный** дальше.';
    const state = makeState(doc, { selection: { anchor: 0 } });
    const hidden = hiddenRanges(state);
    // Обе пары `**` целиком, а не по одной звёздочке: иначе курсор встанет
    // между ними и набранное уедет внутрь жирного.
    expect(hidden.map((r) => doc.slice(r.from, r.to))).toContain('**');
    for (const range of hidden) expect(range.to - range.from).toBeGreaterThan(0);
  });

  it('внутри активного узла ничего не схлопнуто — текст можно править', () => {
    const doc = 'Текст **жирный** дальше.';
    const from = doc.indexOf('**');
    expect(hiddenRanges(makeState(doc, { selection: { anchor: from + 4 } }))).toEqual([]);
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

describe('чекбокс и картинки', () => {
  /*
    Квадрат ЗАМЕЩАЕТ `[ ]`, а не стоит рядом. Пока разметка пряталась
    прозрачностью, скобки держали место и добавочный виджет ложился в их
    просвет; после схлопывания он оказался поверх текста — «☐адача».
  */
  it.each([
    ['курсор далеко', 19],
    ['курсор в самой строке задачи', 8],
  ])('квадрат замещает сырые скобки — %s', (_name, anchor) => {
    const doc = '- [ ] задача\n\nдалее';
    const state = makeState(doc, { selection: { anchor } });
    const widget = decorationsOf(state).find((d) => d.widget === 'TaskBoxWidget');
    expect(widget).toBeDefined();
    const raw = doc.indexOf('[ ]');
    // Диапазон виджета — ровно скобки: у квадрата своя ширина, дыры рядом нет.
    expect(widget?.from).toBe(raw);
    expect(widget?.to).toBe(raw + 3);
    expect(hiddenRanges(state)).toContainEqual({ from: raw, to: raw + 3 });
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
