/**
 * Импорт (ТЗ §5.3, BEHAVIOR §9). Главный критерий DoD:
 * «Импорт реального Obsidian-vault с вложениями — без потерь, ссылки работают»
 * и «Импорт никогда не перезаписывает существующие заметки».
 */
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { applyImport } from '../src/import/apply.js';
import { importFolder, importFolderZip } from '../src/import/obsidian.js';
import { importBear } from '../src/import/bear.js';
import { csvToMarkdownTable, importNotion, parseCsv } from '../src/import/notion.js';
import { enmlToMarkdown, importEvernote, parseEnexDate } from '../src/import/evernote.js';
import { utf8 } from '../src/util/bytes.js';

/** Мини-vault Obsidian: папки, frontmatter, wiki-ссылки, вложения. */
function obsidianVault(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['Мой vault/Заметка о встрече.md', utf8('---\ntags:\n  - работа\naliases: []\n---\n# Заметка о встрече\n\nсм. [[Проекты/Идея продукта]] и ![](attachments/2026-08-08_1a2b3c.png)\n')],
    ['Мой vault/Проекты/Идея продукта.md', utf8('# Идея продукта\n\nОписание. #продукт/идея\n')],
    ['Мой vault/attachments/2026-08-08_1a2b3c.png', new Uint8Array([137, 80, 78, 71, 1, 2, 3])],
    ['Мой vault/.obsidian/workspace.json', utf8('{"служебное":true}')],
    ['Мой vault/.trash/удалённая.md', utf8('# удалённая\n')],
  ]);
}

async function emptyVault(): Promise<Vault> {
  return Vault.open(new MemoryVaultStorage(), { renameDelayMs: 0 });
}

describe('импорт папки .md / Obsidian-vault', () => {
  it('переносит заметки, папки, вложения и frontmatter без потерь', async () => {
    const vault = await emptyVault();
    const bundle = importFolder(obsidianVault());
    expect(bundle.notes).toHaveLength(2);
    expect(bundle.assets).toHaveLength(1);

    const report = await applyImport(vault, bundle);
    expect(report.imported).toBe(2);
    expect(report.attachments).toBe(1);
    expect(report.skipped).toBe(0);

    const note = await vault.read('Заметка о встрече.md');
    expect(note?.body).toContain('---');
    expect(note?.body).toContain('tags:');
    expect(note?.tags).toContain('работа');
    // Структура папок сохранена — значит wiki-ссылка рабочая.
    expect(vault.metaOf('Проекты/Идея продукта.md')).toBeDefined();
    const target = vault.metaOf('Проекты/Идея продукта.md');
    expect(vault.index.backlinks(target?.id as string).map((meta) => meta.path)).toEqual(['Заметка о встрече.md']);
    // Вложение на месте и по относительному пути.
    expect(await vault.storage.read('attachments/2026-08-08_1a2b3c.png')).not.toBeNull();
  });

  it('пропускает служебные каталоги .obsidian и .trash', async () => {
    const bundle = importFolder(obsidianVault());
    expect(bundle.notes.map((note) => note.relativePath)).not.toContain('.trash/удалённая.md');
    expect(bundle.assets.map((asset) => asset.relativePath)).not.toContain('.obsidian/workspace.json');
  });

  it('НИКОГДА не перезаписывает существующие заметки (BEHAVIOR §9)', async () => {
    const vault = await emptyVault();
    await vault.create({ title: 'Заметка о встрече', body: '# Заметка о встрече\n\nмоё, не трогать\n' });

    const report = await applyImport(vault, importFolder(obsidianVault()));
    expect(report.imported).toBe(2);
    const original = await vault.read('Заметка о встрече.md');
    expect(original?.body).toContain('моё, не трогать');
    const imported = await vault.read('Заметка о встрече 2.md');
    expect(imported?.body).toContain('см. [[Проекты/Идея продукта]]');
  });

  it('импортирует в выбранную папку и отчитывается текстом из реестра', async () => {
    const vault = await emptyVault();
    const report = await applyImport(vault, importFolder(obsidianVault()), { targetFolder: 'Импорт' });
    expect(vault.metaOf('Импорт/Заметка о встрече.md')).toBeDefined();
    expect(report.message).toBe('Импортировано 2 · Пропущено 0 — показать');
  });

  it('импорт большого vault не теряет заметки', async () => {
    const files = new Map<string, Uint8Array>();
    for (let i = 0; i < 1000; i += 1) {
      files.set(`vault/Папка ${i % 10}/Заметка ${i}.md`, utf8(`# Заметка ${i}\n\nтело ${i}\n`));
    }
    const vault = await emptyVault();
    const report = await applyImport(vault, importFolder(files));
    expect(report.imported).toBe(1000);
    expect(vault.notes()).toHaveLength(1000);
  });

  it('принимает zip-архив папки', async () => {
    const zip = zipSync({
      'vault/Первая.md': utf8('# Первая\n\nтело\n'),
      'vault/attachments/картинка.png': new Uint8Array([1, 2, 3]),
    });
    const bundle = importFolderZip(zip);
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.assets[0]?.relativePath).toBe('attachments/картинка.png');
  });

  it('умеет отменяться и сообщать прогресс', async () => {
    const vault = await emptyVault();
    const signal = { aborted: false };
    const seen: number[] = [];
    const report = await applyImport(vault, importFolder(obsidianVault()), {
      signal,
      onProgress: (done) => {
        seen.push(done);
        signal.aborted = true;
      },
    });
    expect(seen).toEqual([1]);
    expect(report.imported).toBe(1);
  });
});

describe('импорт Bear (.bear2bk)', () => {
  it('разбирает textbundle и переносит assets в attachments', async () => {
    const zip = zipSync({
      'Заметка.textbundle/text.md': utf8('# Из Bear\n\n![](assets/фото.png)\n'),
      'Заметка.textbundle/assets/фото.png': new Uint8Array([1, 2, 3]),
      'Заметка.textbundle/info.json': utf8('{"version":2}'),
    });
    const bundle = importBear(zip);
    expect(bundle.notes[0]?.relativePath).toBe('Из Bear.md');
    expect(bundle.notes[0]?.body).toContain('![](attachments/фото.png)');
    expect(bundle.assets[0]?.relativePath).toBe('attachments/фото.png');

    const vault = await emptyVault();
    const report = await applyImport(vault, bundle);
    expect(report.imported).toBe(1);
    expect(report.attachments).toBe(1);
  });

  it('сообщает, если .textbundle не найден', () => {
    const bundle = importBear(zipSync({ 'просто.txt': utf8('привет') }));
    expect(bundle.notes).toHaveLength(0);
    expect(bundle.warnings[0]).toContain('.textbundle');
  });
});

describe('импорт Notion', () => {
  it('срезает хеши из имён и конвертирует csv в markdown-таблицу', async () => {
    const zip = zipSync({
      'Export/Заметка 0123456789abcdef0123456789abcdef.md': utf8('# Заметка\n\nтело\n'),
      'Export/База 0123456789abcdef0123456789abcdef.csv': utf8('Название,Статус\n"Первая, важная",В работе\nВторая,Готово\n'),
    });
    const bundle = importNotion(zip);
    const paths = bundle.notes.map((note) => note.relativePath).sort();
    expect(paths).toEqual(['Export/База.md', 'Export/Заметка.md']);
    const table = bundle.notes.find((note) => note.relativePath.endsWith('База.md'))?.body ?? '';
    expect(table).toContain('| Название | Статус |');
    expect(table).toContain('| Первая, важная | В работе |');
    expect(bundle.warnings[0]).toContain('markdown-таблиц');
  });

  it('разбирает CSV с кавычками и переводами строк', () => {
    const rows = parseCsv('a,b\n"мно\nго",2\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['мно\nго', '2'],
    ]);
    expect(csvToMarkdownTable('')).toBe('');
  });
});

describe('импорт Evernote (.enex)', () => {
  const enex = `<?xml version="1.0" encoding="UTF-8"?>
<en-export>
<note>
<title>Встреча с клиентом</title>
<created>20260808T101500Z</created>
<content><![CDATA[<en-note><h1>Встреча</h1><div>Обсудили <b>договор</b> и сроки.</div><ul><li>первый пункт</li><li>второй пункт</li></ul><en-todo checked="true"/>сделано<br/><table><tr><td>Услуга</td><td>Цена</td></tr><tr><td>Консультация</td><td>3000</td></tr></table></en-note>]]></content>
<tag>работа</tag>
<tag>клиенты</tag>
<resource><data encoding="base64">AQID</data><mime>image/png</mime></resource>
</note>
</en-export>`;

  it('конвертирует ENML в markdown с ресурсами и тегами', async () => {
    const bundle = importEvernote(enex);
    expect(bundle.notes).toHaveLength(1);
    const body = bundle.notes[0]?.body ?? '';
    expect(bundle.notes[0]?.relativePath).toBe('Встреча с клиентом.md');
    expect(body).toContain('**договор**');
    expect(body).toContain('- первый пункт');
    expect(body).toContain('| Услуга | Цена |');
    expect(body).toContain('#работа');
    expect(bundle.assets).toHaveLength(1);
    expect(body).toContain(bundle.assets[0]?.relativePath as string);

    const vault = await emptyVault();
    const report = await applyImport(vault, bundle);
    expect(report.imported).toBe(1);
  });

  it('разбирает даты формата ENEX', () => {
    expect(parseEnexDate('20260808T101500Z')).toBe(Date.UTC(2026, 7, 8, 10, 15, 0));
  });

  it('чекбоксы и переводы строк переживают конвертацию', () => {
    const markdown = enmlToMarkdown('<en-note><en-todo/>задача<br/><en-todo checked="true"/>готово</en-note>');
    expect(markdown).toContain('- [ ] задача');
    expect(markdown).toContain('- [x] готово');
  });

  it('пустой файл не роняет импорт', () => {
    const bundle = importEvernote('<en-export></en-export>');
    expect(bundle.notes).toHaveLength(0);
    expect(bundle.warnings).toHaveLength(1);
  });
});
