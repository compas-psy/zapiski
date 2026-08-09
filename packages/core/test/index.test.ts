/**
 * Индекс и FTS (ADR-0002, BEHAVIOR §4): операторы, ранжирование, фрагменты,
 * backlinks, зашифрованные заметки, персистентность.
 */
import { describe, expect, it } from 'vitest';
import type { Note } from '../src/contract.js';
import { InvertedIndex } from '../src/index/note-index.js';
import { parseQuery, formatQuery, parseDateToken } from '../src/index/query.js';
import { parseNote } from '../src/markdown/parse.js';

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 7, 1);

function note(partial: Partial<Note> & { id: string; path: string; body: string }): Note {
  const parsed = parseNote(partial.body);
  return {
    id: partial.id,
    path: partial.path,
    title: partial.title ?? parsed.title,
    snippet: parsed.snippet,
    createdAt: partial.createdAt ?? BASE,
    updatedAt: partial.updatedAt ?? BASE,
    pinned: false,
    archived: false,
    tags: parsed.tags,
    encrypted: partial.encrypted ?? false,
    hasImage: parsed.hasImage,
    hasFile: parsed.hasFile,
    hasTodo: parsed.hasTodo,
    hasLink: parsed.hasLink,
    wordCount: parsed.wordCount,
    body: partial.body,
  };
}

function makeIndex(): InvertedIndex {
  const index = new InvertedIndex();
  index.rebuild([
    note({
      id: '1',
      path: 'Практика/Супервизия.md',
      body: '# Супервизия\n\nРазбор случая с коллегой. #практика/супервизия\n\n![](attachments/2026-08-01_aaa.png)',
      updatedAt: BASE,
    }),
    note({
      id: '2',
      path: 'Личное/Ёлка.md',
      body: '# Ёлка на даче\n\nКупить гирлянду и игрушки.\n\n- [ ] проверить лампочки\n\nсм. [[Супервизия]]',
      updatedAt: BASE + DAY,
    }),
    note({
      id: '3',
      path: 'Личное/Заметка о встрече.md',
      body: '# Заметка о встрече\n\nВстретились и обсудили разбор случая, потом ещё раз разбор.\n\n[договор](files/dogovor.docx)',
      updatedAt: BASE + 2 * DAY,
    }),
    note({
      id: '4',
      path: 'Дневник.md.enc',
      title: 'Дневник',
      body: '',
      encrypted: true,
      updatedAt: BASE + 3 * DAY,
    }),
  ]);
  return index;
}

describe('разбор строки запроса (BEHAVIOR §4)', () => {
  it('разбирает все операторы', () => {
    const query = parseQuery('разбор tag:практика folder:Личное before:2026-08-10 after:2026-08-01 has:image "точная фраза" -лишнее');
    expect(query.text).toBe('разбор');
    expect(query.filters.tag).toEqual(['практика']);
    expect(query.filters.folder).toEqual(['Личное']);
    expect(query.filters.before).toBe(Date.UTC(2026, 7, 10));
    expect(query.filters.after).toBe(Date.UTC(2026, 7, 1));
    expect(query.filters.has).toEqual(['image']);
    expect(query.filters.phrases).toEqual(['точная фраза']);
    expect(query.filters.exclude).toEqual(['лишнее']);
  });

  it('понимает относительные даты', () => {
    const now = Date.UTC(2026, 7, 9, 15, 0, 0);
    expect(parseDateToken('вчера', now)).toBe(Date.UTC(2026, 7, 8));
    expect(parseDateToken('сегодня', now)).toBe(Date.UTC(2026, 7, 9));
    expect(parseDateToken('2026', now)).toBe(Date.UTC(2026, 0, 1));
    expect(parseDateToken('чепуха', now)).toBeNull();
  });

  it('строка и чипы синхронны: обратная сборка', () => {
    const source = 'разбор tag:практика folder:Личное has:todo -лишнее';
    expect(formatQuery(parseQuery(source))).toBe(source);
  });
});

describe('поиск', () => {
  it('находит по слову в теле', () => {
    const hits = makeIndex().search(parseQuery('гирлянду'));
    expect(hits.map((hit) => hit.note.id)).toEqual(['2']);
  });

  it('нормализует ё → е и регистр', () => {
    const index = makeIndex();
    expect(index.search(parseQuery('елка')).map((hit) => hit.note.id)).toEqual(['2']);
    expect(index.search(parseQuery('ЁЛКА')).map((hit) => hit.note.id)).toEqual(['2']);
  });

  it('совпадение в заголовке ранжируется выше, чем в тексте', () => {
    const index = new InvertedIndex();
    index.rebuild([
      note({ id: 'body', path: 'В теле.md', body: '# В теле\n\nздесь есть супервизия внутри текста', updatedAt: BASE + DAY }),
      note({ id: 'title', path: 'Супервизия.md', body: '# Супервизия\n\nсовсем про другое', updatedAt: BASE }),
    ]);
    const hits = index.search(parseQuery('супервизия'));
    expect(hits[0]?.note.id).toBe('title');
    expect((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0)).toBe(true);
  });

  it('при равенстве очков выигрывает свежесть', () => {
    const index = new InvertedIndex();
    index.rebuild([
      note({ id: 'old', path: 'Старая.md', body: '# Старая\n\nодинаковое слово', updatedAt: BASE }),
      note({ id: 'new', path: 'Новая.md', body: '# Новая\n\nодинаковое слово', updatedAt: BASE + DAY }),
    ]);
    expect(makeIds(index.search(parseQuery('одинаковое')))).toEqual(['new', 'old']);
  });

  it('оператор tag: учитывает вложенные теги', () => {
    const index = makeIndex();
    expect(makeIds(index.search(parseQuery('tag:практика')))).toEqual(['1']);
    expect(makeIds(index.search(parseQuery('tag:практика/супервизия')))).toEqual(['1']);
    expect(index.byTag('практика')).toHaveLength(1);
  });

  it('оператор folder: фильтрует по папке', () => {
    const ids = makeIds(makeIndex().search(parseQuery('folder:Личное')));
    expect(ids.sort()).toEqual(['2', '3']);
  });

  it('операторы before:/after: фильтруют по дате изменения', () => {
    const index = makeIndex();
    // Граница включающая: заметка, изменённая ровно 3 августа, попадает.
    expect(makeIds(index.search(parseQuery('after:2026-08-03')))).toEqual(['3']);
    expect(makeIds(index.search(parseQuery('after:2026-08-04')))).toEqual([]);
    const recent = makeIds(index.search(parseQuery('after:2026-08-02')));
    expect(recent).toContain('3');
    // `before:` исключающая: «до 2 августа» — это строго раньше 2 августа.
    expect(makeIds(index.search(parseQuery('before:2026-08-02')))).toEqual(['1']);
    expect(makeIds(index.search(parseQuery('before:2026-08-03'))).sort()).toEqual(['1', '2']);
  });

  it('оператор has: работает для image, file, todo, link', () => {
    const index = makeIndex();
    expect(makeIds(index.search(parseQuery('has:image')))).toEqual(['1']);
    expect(makeIds(index.search(parseQuery('has:file')))).toEqual(['3']);
    expect(makeIds(index.search(parseQuery('has:todo')))).toEqual(['2']);
    expect(makeIds(index.search(parseQuery('has:link'))).sort()).toEqual(['2', '3']);
  });

  it('точная фраза в кавычках', () => {
    const index = makeIndex();
    expect(makeIds(index.search(parseQuery('"разбор случая"'))).sort()).toEqual(['1', '3']);
    expect(makeIds(index.search(parseQuery('"случая разбор"')))).toEqual([]);
  });

  it('исключение -слово', () => {
    const index = makeIndex();
    expect(makeIds(index.search(parseQuery('разбор -коллегой')))).toEqual(['3']);
  });

  it('до 3 фрагментов с контекстом и диапазонами подсветки', () => {
    const index = new InvertedIndex();
    const filler = 'наполнение текста для контекста. ';
    index.rebuild([
      note({
        id: 'f',
        path: 'Фрагменты.md',
        body: `# Фрагменты\n\n${filler}маркер ${filler}маркер ${filler}маркер ${filler}маркер ${filler}`,
      }),
    ]);
    const [hit] = index.search(parseQuery('маркер'));
    expect(hit?.fragments.length).toBeGreaterThan(0);
    expect(hit?.fragments.length).toBeLessThanOrEqual(3);
    for (const fragment of hit?.fragments ?? []) {
      expect(fragment.ranges.length).toBeGreaterThan(0);
      for (const [start, end] of fragment.ranges) {
        expect(fragment.text.slice(start, end).toLowerCase()).toBe('маркер');
      }
    }
  });

  it('зашифрованные не индексируются и идут в конец выдачи', () => {
    const index = makeIndex();
    // Тело зашифрованной заметки в индекс не попало.
    expect(makeIds(index.search(parseQuery('дневник')))).toEqual(['4']);
    const hit = index.search(parseQuery('дневник'))[0];
    expect(hit?.encryptedPlaceholder).toBe(true);
    expect(hit?.fragments).toEqual([]);

    const mixed = index.search(parseQuery('разбор дневник'));
    expect(mixed[mixed.length - 1]?.encryptedPlaceholder).toBe(true);
  });

  it('ограничение выдачи соблюдается', () => {
    const index = new InvertedIndex();
    index.rebuild(
      Array.from({ length: 30 }, (_, i) =>
        note({ id: `n${i}`, path: `Заметка ${i}.md`, body: `# Заметка ${i}\n\nобщее слово` }),
      ),
    );
    expect(index.search(parseQuery('общее'), 10)).toHaveLength(10);
  });
});

describe('backlinks (BEHAVIOR §2.10)', () => {
  it('считает wiki-ссылки и markdown-ссылки', () => {
    const index = new InvertedIndex();
    index.rebuild([
      note({ id: 'target', path: 'Идея.md', body: '# Идея\n\nтело' }),
      note({ id: 'wiki', path: 'Первая.md', body: '# Первая\n\n[[Идея]]' }),
      note({ id: 'md', path: 'Вторая.md', body: '# Вторая\n\n[идея](Идея.md)' }),
      note({ id: 'none', path: 'Третья.md', body: '# Третья\n\nбез ссылок' }),
    ]);
    expect(index.backlinks('target').map((meta) => meta.id).sort()).toEqual(['md', 'wiki']);
    expect(index.backlinks('none')).toEqual([]);
  });

  it('ссылки из подпапок разрешаются относительно заметки', () => {
    const index = new InvertedIndex();
    index.rebuild([
      note({ id: 'target', path: 'Проекты/Идея.md', body: '# Идея\n\nтело' }),
      note({ id: 'source', path: 'Проекты/Задачи.md', body: '# Задачи\n\n[идея](Идея.md)' }),
    ]);
    expect(index.backlinks('target').map((meta) => meta.id)).toEqual(['source']);
  });
});

describe('персистентность индекса (ADR-0002)', () => {
  it('снапшот загружается и даёт те же результаты', () => {
    const source = makeIndex();
    const snapshot = JSON.parse(JSON.stringify(source.toJSON())) as unknown;
    const restored = new InvertedIndex();
    expect(restored.loadSnapshot(snapshot)).toBe(true);
    expect(makeIds(restored.search(parseQuery('разбор')))).toEqual(makeIds(source.search(parseQuery('разбор'))));
    expect(restored.backlinks('1').map((meta) => meta.id)).toEqual(['2']);
  });

  it('повреждённый снапшот отвергается — нужна полная перестройка', () => {
    const index = new InvertedIndex();
    expect(index.loadSnapshot(null)).toBe(false);
    expect(index.loadSnapshot({ version: 999, notes: [] })).toBe(false);
    expect(index.loadSnapshot({ version: 1, notes: [{ meta: null, plain: 'x' }] })).toBe(false);
  });
});

describe('изменение состава индекса', () => {
  it('add/update/remove поддерживают постинги в согласованном виде', () => {
    const index = new InvertedIndex();
    const first = note({ id: 'a', path: 'А.md', body: '# А\n\nальфа' });
    index.add(first);
    expect(makeIds(index.search(parseQuery('альфа')))).toEqual(['a']);
    index.update({ ...first, body: '# А\n\nбета', title: 'А' });
    expect(makeIds(index.search(parseQuery('альфа')))).toEqual([]);
    expect(makeIds(index.search(parseQuery('бета')))).toEqual(['a']);
    index.remove('a');
    expect(index.all()).toEqual([]);
  });
});

function makeIds(hits: Array<{ note: { id: string } }>): string[] {
  return hits.map((hit) => hit.note.id);
}
