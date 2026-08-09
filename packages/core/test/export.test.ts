/**
 * Экспорт (ТЗ §5.3, BEHAVIOR §9): md (zip), HTML, DOCX, PDF.
 * «Всё бесплатно, без paywall» — прямой ответ на боль Bear.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import type { Note, PdfPageSetup } from '../src/contract.js';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { markdownToHtml, renderPrintableHtml } from '../src/export/html.js';
import { exportDocx } from '../src/export/docx.js';
import { exportArchive, exportNote } from '../src/export/archive.js';
import { exportPdf, PDF_PAGE_SETUP } from '../src/export/pdf.js';
import { parseNote } from '../src/markdown/parse.js';
import { utf8, fromUtf8 } from '../src/util/bytes.js';

const BODY = `# Отчёт о встрече

Обсудили **договор**, *сроки* и ==важное==. Ссылка: [сайт](https://cmpas.ru), вики: [[Идея продукта]].

## Задачи

- [x] отправить смету
- [ ] назначить созвон

1. первый
2. второй

> Цитата клиента

| Услуга | Цена |
| --- | --- |
| Консультация | 3000 |

\`\`\`ts
const x: number = 1;
\`\`\`

![](attachments/2026-08-08_1a2b3c.png)

---

[^1]: сноска
`;

function makeNote(): Note {
  const parsed = parseNote(BODY);
  return {
    id: 'n1',
    path: 'Отчёт о встрече.md',
    title: parsed.title,
    snippet: parsed.snippet,
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: Date.UTC(2026, 7, 8),
    pinned: false,
    archived: false,
    tags: parsed.tags,
    encrypted: false,
    hasImage: parsed.hasImage,
    hasFile: parsed.hasFile,
    hasTodo: parsed.hasTodo,
    hasLink: parsed.hasLink,
    wordCount: parsed.wordCount,
    body: BODY,
  };
}

describe('экспорт в HTML', () => {
  const html = markdownToHtml(BODY);

  it('переносит все элементы разметки', () => {
    expect(html).toContain('<h1>Отчёт о встрече</h1>');
    expect(html).toContain('<strong>договор</strong>');
    expect(html).toContain('<em>сроки</em>');
    expect(html).toContain('<mark>важное</mark>');
    expect(html).toContain('<a href="https://cmpas.ru">сайт</a>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre data-lang="ts">');
    expect(html).toContain('<img src="attachments/2026-08-08_1a2b3c.png"');
    expect(html).toContain('<hr>');
  });

  it('экранирует пользовательский текст', () => {
    expect(markdownToHtml('# <script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('печатный документ — светлая «Бумага», колонка 640, без интерфейса', () => {
    const printable = renderPrintableHtml(makeNote());
    expect(printable).toContain('<!doctype html>');
    expect(printable).toContain('max-width: 640px');
    expect(printable).toContain('color-scheme: light');
    expect(printable).not.toContain('<nav');
    expect(printable).not.toContain('<button');
    expect(printable).toContain('Отчёт о встрече');
  });
});

describe('экспорт в DOCX', () => {
  it('собирает валидный по структуре пакет OOXML', () => {
    const docx = exportDocx(makeNote());
    const files = unzipSync(docx);
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/numbering.xml',
      'word/styles.xml',
    ]);
    const document = fromUtf8(files['word/document.xml'] as Uint8Array);
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toContain('Отчёт о встрече');
    expect(document).toContain('<w:b/>');
    expect(document).toContain('<w:numPr>');
    expect(document).toContain('<w:tbl>');
    expect(document).toContain('☑');
  });
});

describe('экспорт нескольких заметок', () => {
  it('zip сохраняет структуру папок и вложения', async () => {
    const storage = new MemoryVaultStorage({
      files: {
        'Проекты/Идея.md': '# Идея\n\n![](attachments/pic.png)\n',
        'Личное/Заметка.md': '# Заметка\n\nтекст\n',
        'attachments/pic.png': 'байты',
      },
    });
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    const zip = await exportArchive(vault, ['Проекты/Идея.md', 'Личное/Заметка.md']);
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['attachments/pic.png', 'Личное/Заметка.md', 'Проекты/Идея.md']);
  });

  it('зашифрованная заметка в архив не попадает без разблокировки', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Дневник.md.enc': 'ZPSK…' } });
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    const zip = await exportArchive(vault, ['Дневник.md.enc']);
    expect(Object.keys(unzipSync(zip))).toHaveLength(0);
  });

  it('одна заметка выгружается в выбранном формате', () => {
    const note = makeNote();
    expect(exportNote(note, 'md').name).toBe('Отчёт о встрече.md');
    expect(fromUtf8(exportNote(note, 'md').data)).toBe(BODY);
    expect(exportNote(note, 'html').name).toBe('Отчёт о встрече.html');
    expect(exportNote(note, 'docx').data.length).toBeGreaterThan(0);
  });
});

describe('экспорт в PDF', () => {
  it('отдаёт печатный HTML платформенному рендереру с нужными настройками', async () => {
    let seen: { html: string; setup: PdfPageSetup } | null = null;
    const renderer = {
      async render(html: string, setup: PdfPageSetup): Promise<Uint8Array> {
        seen = { html, setup };
        return utf8('%PDF-1.7');
      },
    };
    const data = await exportPdf(makeNote(), renderer);
    expect(fromUtf8(data)).toContain('%PDF');
    expect(seen?.setup).toEqual(PDF_PAGE_SETUP);
    expect(PDF_PAGE_SETUP).toEqual({ columnWidth: 640, marginMm: 18, theme: 'paper' });
    expect(seen?.html).toContain('max-width: 640px');
  });
});
