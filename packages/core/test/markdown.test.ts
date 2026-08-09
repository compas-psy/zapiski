/**
 * Разбор markdown (ТЗ §3.2): CommonMark + GFM + `[[wiki]]`, `==highlight==`,
 * сноски, `#вложенные/теги`; заголовок и признаки `has:` (BEHAVIOR §2.2, §4).
 */
import { describe, expect, it } from 'vitest';
import {
  extractLinks,
  extractTags,
  extractTitle,
  extractWikiLinks,
  hasTodo,
  parseNote,
  stripMarkdown,
} from '../src/markdown/parse.js';
import { Frontmatter, joinFrontmatter, splitFrontmatter } from '../src/markdown/frontmatter.js';
import { inlineToText, parseBlocks, parseInline } from '../src/markdown/ast.js';
import { countWords, normalizeText, tokenize, truncate } from '../src/util/text.js';
import { joinPath, normalizePath, relativePath, stemOf } from '../src/util/path.js';
import { fromBase64, toBase64, toHex, utf8, fromUtf8, bytesEqual } from '../src/util/bytes.js';

describe('заголовок (BEHAVIOR §2.2)', () => {
  it('берёт первую строку, снимая решётку', () => {
    expect(extractTitle('# Заметка о встрече\n\nтело')).toBe('Заметка о встрече');
  });

  it('первая непустая строка без решётки — тоже заголовок', () => {
    expect(extractTitle('\n\nПросто строка\n\nтело')).toBe('Просто строка');
  });

  it('снимает инлайн-разметку из заголовка', () => {
    expect(extractTitle('# **Важное** и ==яркое==')).toBe('Важное и яркое');
  });

  it('пустой файл — пустой заголовок', () => {
    expect(extractTitle('')).toBe('');
  });
});

describe('теги', () => {
  it('находит вложенные теги и не путает их с заголовком', () => {
    expect(extractTags('# Заголовок\n\n#практика/супервизия и #работа')).toEqual(['практика/супервизия', 'работа']);
  });

  it('игнорирует теги в коде и якоря ссылок', () => {
    expect(extractTags('`#нет`\n\n```\n#тоже-нет\n```\n\n[ссылка](https://x.ru/page#anchor)\n\n#да')).toEqual(['да']);
  });

  it('не дублирует теги в разном регистре', () => {
    expect(extractTags('#Работа и #работа')).toEqual(['Работа']);
  });
});

describe('ссылки', () => {
  it('разбирает wiki-ссылки с алиасом и якорем', () => {
    const links = extractWikiLinks('[[Идея]] [[Идея|как её звали]] [[Проекты/План#Раздел]]');
    expect(links.map((link) => link.target)).toEqual(['Идея', 'Идея', 'Проекты/План']);
    expect(links[1]?.alias).toBe('как её звали');
    expect(links[2]?.anchor).toBe('Раздел');
  });

  it('разбирает markdown-ссылки и изображения', () => {
    const links = extractLinks('![схема](attachments/pic.png) и [сайт](https://cmpas.ru "тайтл")');
    expect(links[0]?.image).toBe(true);
    expect(links[0]?.url).toBe('attachments/pic.png');
    expect(links[1]?.url).toBe('https://cmpas.ru');
  });
});

describe('признаки has: (BEHAVIOR §4)', () => {
  it('определяет изображения, файлы, чекбоксы и ссылки', () => {
    const parsed = parseNote(
      '# Всё сразу\n\n![](attachments/p.png)\n\n[договор](files/d.docx)\n\n- [ ] задача\n\n[[Идея]]\n',
    );
    expect(parsed.hasImage).toBe(true);
    expect(parsed.hasFile).toBe(true);
    expect(parsed.hasTodo).toBe(true);
    expect(parsed.hasLink).toBe(true);
    expect(hasTodo('- [x] сделано')).toBe(true);
    expect(hasTodo('- обычный пункт')).toBe(false);
  });

  it('внешняя ссылка не считается файлом', () => {
    const parsed = parseNote('# Ссылка\n\n[сайт](https://cmpas.ru)\n');
    expect(parsed.hasFile).toBe(false);
    expect(parsed.hasLink).toBe(true);
  });
});

describe('снятие разметки и сниппет', () => {
  it('оставляет текст, убирая маркеры', () => {
    const plain = stripMarkdown('# Заголовок\n\n> цитата\n\n- пункт\n\n**жирный** `код`\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(plain).toContain('Заголовок');
    expect(plain).toContain('цитата');
    expect(plain).toContain('пункт');
    expect(plain).toContain('жирный код');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('---');
  });

  it('содержимое код-блока сохраняется — его ищут', () => {
    expect(stripMarkdown('```ts\nconst x = 1;\n```')).toContain('const x = 1;');
  });

  it('сниппет — до 200 знаков без разметки и без заголовка', () => {
    const parsed = parseNote(`# Заголовок\n\n${'слово '.repeat(100)}`);
    expect(parsed.snippet.length).toBeLessThanOrEqual(201);
    expect(parsed.snippet).not.toContain('Заголовок');
    expect(truncate('короткая строка', 100)).toBe('короткая строка');
  });

  it('plain считается лениво, но корректно', () => {
    const parsed = parseNote('# Заголовок\n\n**жирный** текст');
    expect(parsed.plain).toContain('жирный текст');
    expect(parsed.plain).toBe(parsed.plain);
  });
});

describe('frontmatter (ТЗ §3.2, опционален)', () => {
  it('разбирает скаляры, списки и inline-массивы', () => {
    const { frontmatter, body } = splitFrontmatter(
      '---\nid: abc\npinned: true\ncount: 3\ntags:\n  - работа\n  - "личное"\naliases: [Первая, Вторая]\n---\n# Тело\n',
    );
    expect(frontmatter?.getString('id')).toBe('abc');
    expect(frontmatter?.getBoolean('pinned')).toBe(true);
    expect(frontmatter?.getNumber('count')).toBe(3);
    expect(frontmatter?.getList('tags')).toEqual(['работа', 'личное']);
    expect(frontmatter?.getList('aliases')).toEqual(['Первая', 'Вторая']);
    expect(body).toBe('# Тело\n');
  });

  it('сохраняет незнакомые строки при перезаписи (совместимость с Obsidian)', () => {
    const source = '---\ncssclass: my-class\nunknown:\n  nested: value\n---\nтело\n';
    const { frontmatter, body } = splitFrontmatter(source);
    frontmatter?.set('updated', '2026-08-08T00:00:00.000Z');
    const result = joinFrontmatter(frontmatter, body);
    expect(result).toContain('cssclass: my-class');
    expect(result).toContain('nested: value');
    expect(result).toContain('updated: 2026-08-08T00:00:00.000Z');
  });

  it('отсутствие и незакрытый блок — не ошибка', () => {
    expect(splitFrontmatter('# Просто заметка').frontmatter).toBeNull();
    expect(splitFrontmatter('---\nid: abc\n# без закрытия').frontmatter).toBeNull();
    expect(joinFrontmatter(null, 'тело')).toBe('тело');
    expect(joinFrontmatter(Frontmatter.parse([]), 'тело')).toBe('тело');
  });

  it('удаление ключа и проверка наличия', () => {
    const fm = Frontmatter.parse(['id: abc', 'pinned: false']);
    expect(fm.has('pinned')).toBe(true);
    fm.remove('pinned');
    expect(fm.has('pinned')).toBe(false);
    expect(fm.keys).toEqual(['id']);
  });

  it('BOM и CRLF не ломают разбор', () => {
    const { frontmatter, body } = splitFrontmatter('﻿---\r\nid: abc\r\n---\r\n# Тело\r\n');
    expect(frontmatter?.getString('id')).toBe('abc');
    expect(body).toContain('# Тело');
  });
});

describe('AST для экспорта', () => {
  it('разбирает блоки', () => {
    const blocks = parseBlocks('# H1\n\nабзац\n\n- [ ] пункт\n\n> цитата\n\n```js\ncode\n```\n\n---\n');
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'code', 'hr']);
  });

  it('разбирает инлайн-разметку', () => {
    const nodes = parseInline('**жирный** *курсив* ~~зачёркнутый~~ ==выделенный== `код` [[Вики|алиас]]');
    expect(nodes.map((node) => node.type)).toEqual([
      'strong',
      'text',
      'em',
      'text',
      'strike',
      'text',
      'mark',
      'text',
      'code',
      'text',
      'wiki',
    ]);
    expect(inlineToText(nodes)).toContain('алиас');
  });
});

describe('утилиты', () => {
  it('нормализация ё → е и регистр', () => {
    expect(normalizeText('ЁЛКА Ёжик')).toBe('елка ежик');
    expect(tokenize('Привет, мир!').map((token) => token.term)).toEqual(['привет', 'мир']);
    expect(countWords('одно два три')).toBe(3);
  });

  it('пути всегда с прямыми слэшами и без ведущего', () => {
    expect(normalizePath('\\Проекты\\Идея.md')).toBe('Проекты/Идея.md');
    expect(normalizePath('./Проекты/../Идея.md')).toBe('Идея.md');
    expect(joinPath('Проекты', 'Идея.md')).toBe('Проекты/Идея.md');
    expect(stemOf('Проекты/Идея.md.enc')).toBe('Идея');
    expect(relativePath('Проекты', 'attachments/pic.png')).toBe('../attachments/pic.png');
  });

  it('base64 и hex round-trip', () => {
    const data = utf8('Привет, ЗАПИСКИ');
    expect(fromUtf8(fromBase64(toBase64(data)))).toBe('Привет, ЗАПИСКИ');
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
    expect(bytesEqual(data, new Uint8Array(data))).toBe(true);
    expect(bytesEqual(data, new Uint8Array([1]))).toBe(false);
  });
});
