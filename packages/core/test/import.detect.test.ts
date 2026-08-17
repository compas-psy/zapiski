/**
 * Импорт: источник определяется сам, потери видны до запуска, отчёт не врёт.
 *
 * Спецификация — `docs/design/handoff-import/IMPORT.md`. Три её требования
 * держатся здесь, и каждое куплено продуктовым решением, а не техническим:
 *
 *  · §0.2 **выбора источника нет** — ни экрана, ни радиокнопок. Человек знает,
 *    из какого приложения ушёл, а не в каком формате его экспорт. Значит
 *    определение обязано быть надёжным: ошибка здесь = заголовок шага 2 врёт;
 *  · §2 **о потерях сообщаем ДО запуска**. Значит числа и список упрощений
 *    существуют раньше первой записи в vault;
 *  · §4 **исходники не меняются, существующие заметки не перезаписываются**, а
 *    отчёт показывает суффиксы и переписанные ссылки — и обе цифры настоящие.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { applyImport } from '../src/import/apply.js';
import { detectImportSource, defaultImportFolder } from '../src/import/detect.js';
import { scanImport } from '../src/import/scan.js';
import { emptyBundle, IMPORT_ASSET_LIMIT } from '../src/import/types.js';
import { importFolder } from '../src/import/obsidian.js';
import { utf8 } from '../src/util/bytes.js';

const NOTION_TAIL = '1f2c3d4e5a6b7c8d9e0f1a2b3c4d5e6f';

describe('источник определяется по содержимому (§3)', () => {
  it('каталог .obsidian — хранилище Obsidian', () => {
    expect(
      detectImportSource(['.obsidian/app.json', 'Идеи.md', 'Работа/Смета.md']),
    ).toBe('obsidian');
  });

  it('порядок проверок: .enex раньше Bear и markdown', () => {
    /* Выгрузка Evernote вполне может лежать в папке с чем угодно ещё — и это
       по-прежнему Evernote, а не «папка с markdown». */
    expect(detectImportSource(['Блокнот.enex', 'Заметки/старое.md'])).toBe('evernote');
  });

  it('пакеты Bear опознаются и в архиве, и распакованными', () => {
    expect(detectImportSource(['Идея.textbundle/text.md', 'Идея.textbundle/info.json'])).toBe(
      'bear',
    );
    expect(detectImportSource(['Экспорт/Мысль.bearnote'])).toBe('bear');
  });

  it('Notion опознаётся по хвостам-идентификаторам, а не по расширению', () => {
    const files = [
      `Проект ${NOTION_TAIL}.md`,
      `Проект ${NOTION_TAIL}/Задачи ${NOTION_TAIL}.md`,
      `Проект ${NOTION_TAIL}/База ${NOTION_TAIL}.csv`,
      'README.md',
    ];
    expect(detectImportSource(files)).toBe('notion');
  });

  it('один такой файл среди сотни своих — это НЕ Notion', () => {
    /*
     * Порог доли (30%) существует ровно для этого: человек мог однажды
     * сохранить себе одну страницу из Notion, и объявлять из-за неё всё
     * хранилище ноушновским нельзя — заголовок шага 2 соврал бы, а структура
     * папок поехала бы «со структурой страниц».
     */
    const files = [`Одна ${NOTION_TAIL}.md`, ...Array.from({ length: 20 }, (_, i) => `Своё ${i}.md`)];
    expect(detectImportSource(files)).toBe('markdown');
  });

  it('просто папка с markdown — честный фолбэк', () => {
    expect(detectImportSource(['Дневник.md', 'фото.png'])).toBe('markdown');
  });

  it('ни одного поддерживаемого файла — «не удалось прочитать это»', () => {
    expect(detectImportSource(['архив.rar', 'фото.png'])).toBe('unknown');
  });

  it('целевая папка называется источником, а не датой', () => {
    /* Человек ищет свои заметки словом, которым называл их сам: «где мой
       Obsidian», а не «где Импорт 17 августа». */
    expect(defaultImportFolder('obsidian')).toBe('Obsidian');
    expect(defaultImportFolder('notion')).toBe('Notion');
    expect(defaultImportFolder('markdown')).toBe('Импорт');
    expect(defaultImportFolder('unknown')).toBe('Импорт');
  });
});

describe('скан показывает потери ДО запуска (§2)', () => {
  it('у папки с markdown потерь нет вовсе — блока на экране быть не должно', () => {
    const files = new Map([
      ['Идеи.md', utf8('# Идеи\n')],
      ['Работа/Смета.md', utf8('# Смета\n')],
    ]);
    const scan = scanImport(files, importFolder(files));

    expect(scan.source).toBe('markdown');
    expect(scan.documents).toBe(2);
    expect(scan.losses, 'придумали потери там, где их нет').toEqual([]);
  });

  it('у Notion названы базы, вложенные страницы и то, что ляжет как есть', () => {
    const files = new Map<string, Uint8Array>([
      [`Проект ${NOTION_TAIL}.md`, utf8('# Проект\n')],
      [`Проект ${NOTION_TAIL}/Задачи ${NOTION_TAIL}.md`, utf8('# Задачи\n')],
      [`Проект ${NOTION_TAIL}/База ${NOTION_TAIL}.csv`, utf8('Имя,Статус\nА,готово\n')],
      [`Проект ${NOTION_TAIL}/виджет ${NOTION_TAIL}.html`, utf8('<div>виджет</div>')],
    ]);
    const bundle = emptyBundle();
    bundle.notes.push({ relativePath: 'Проект.md', body: '# Проект\n' });
    const scan = scanImport(files, bundle);

    expect(scan.source).toBe('notion');
    expect(scan.groups, 'третья плитка у Notion — базы данных').toBe(1);
    expect(scan.losses).toContainEqual({ kind: 'notion-databases', count: 1 });
    expect(scan.losses).toContainEqual({ kind: 'notion-subpages' });
    expect(scan.losses).toContainEqual({ kind: 'kept-as-is', count: 1 });
  });

  it('у Evernote названы таблицы и рукописные вложения', () => {
    const enex = utf8(
      '<en-export><note><content><table><tr><td>а</td></tr></table></content>' +
        '<resource><mime>application/vnd.evernote.ink</mime></resource></note></en-export>',
    );
    const files = new Map([['Блокнот.enex', enex]]);
    const scan = scanImport(files, emptyBundle());

    expect(scan.source).toBe('evernote');
    expect(scan.groups, 'третья плитка у Evernote — блокноты').toBe(1);
    expect(scan.losses).toContainEqual({ kind: 'evernote-tables' });
    expect(scan.losses).toContainEqual({ kind: 'evernote-handwriting', count: 1 });
  });
});

describe('перенос: ничего не перезаписано, отчёт честный (§4)', () => {
  async function vaultWith(files: Record<string, string>): Promise<Vault> {
    const vault = new Vault(new MemoryVaultStorage({ files }));
    await vault.rebuild();
    return vault;
  }

  it('совпадение имени даёт суффикс, а ссылки едут за ним', async () => {
    /*
     * Самое дорогое место импорта. Заметка с занятым именем получает суффикс —
     * и все `[[ссылки]]` внутри принесённого, которые вели на прежнее имя,
     * обязаны поехать туда же. Иначе человек получает связанный архив, в
     * котором связи ведут в пустоту, и узнаёт об этом через месяц.
     */
    const vault = await vaultWith({ 'Идея.md': '# Идея\n\nсвоя, уже была\n' });
    const bundle = emptyBundle();
    bundle.notes.push({ relativePath: 'Идея.md', body: '# Идея\n\nпринесённая\n' });
    bundle.notes.push({ relativePath: 'Дневник.md', body: 'ссылка на [[Идея]] и ещё [[Идея|та же]]\n' });

    const report = await applyImport(vault, bundle);

    expect(report.imported).toBe(2);
    expect(report.suffixed, 'суффикс не посчитан').toBe(1);
    expect(report.linksRewritten, 'ссылки не поехали за переименованием').toBe(2);
    /* Своя заметка цела — это инвариант, а не пожелание. */
    expect((await vault.read('Идея.md'))?.body).toContain('своя, уже была');
    expect((await vault.read('Идея 2.md'))?.body).toContain('принесённая');
    expect((await vault.read('Дневник.md'))?.body).toContain('[[Идея 2]]');
  });

  it('вложение больше 200 МБ пропускается, заметка переносится', async () => {
    const vault = await vaultWith({});
    const bundle = emptyBundle();
    bundle.notes.push({ relativePath: 'Лекция.md', body: '# Лекция\n\n![[лекция.mov]]\n' });
    bundle.assets.push({
      relativePath: 'attachments/лекция.mov',
      data: new Uint8Array(IMPORT_ASSET_LIMIT + 1),
    });

    const report = await applyImport(vault, bundle);

    expect(report.imported, 'заметку потеряли из-за вложения').toBe(1);
    expect(report.attachments).toBe(0);
    expect(report.skips).toEqual([{ path: 'attachments/лекция.mov', reason: 'too-large' }]);
  });

  it('прогресс называет текущий путь — иначе экран хода показывать нечего', async () => {
    const vault = await vaultWith({});
    const bundle = emptyBundle();
    bundle.notes.push({ relativePath: 'Первая.md', body: '# Первая\n' });
    bundle.notes.push({ relativePath: 'Вторая.md', body: '# Вторая\n' });

    const seen: Array<string | undefined> = [];
    await applyImport(vault, bundle, {
      onProgress: (_done, _total, path) => seen.push(path),
    });

    expect(seen).toEqual(['Первая.md', 'Вторая.md']);
  });

  it('остановка сохраняет уже перенесённое', async () => {
    /* §2, шаг 3: «Остановить перенос? Уже перенесённые заметки останутся.» —
       обещание, которое обязано быть правдой. */
    const vault = await vaultWith({});
    const bundle = emptyBundle();
    bundle.notes.push({ relativePath: 'Первая.md', body: '# Первая\n' });
    bundle.notes.push({ relativePath: 'Вторая.md', body: '# Вторая\n' });
    const signal = { aborted: false };

    const report = await applyImport(vault, bundle, {
      signal,
      onProgress: () => {
        signal.aborted = true;
      },
    });

    expect(report.imported).toBe(1);
    expect(await vault.read('Первая.md')).not.toBeNull();
  });
});
