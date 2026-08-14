/**
 * Смена места синхронизации: папка → облако.
 *
 * ── Вопрос, ради которого написан файл ──────────────────────────────────────
 *
 * «Сидел человек на локальной папке и накопил кучу записок. Решил подключить
 * облако: что происходит с этими файлами?»
 *
 * Ответ обязан быть один и предсказуемый: **ничего не пропадает**. Всё, что
 * есть здесь, уезжает туда; всё, что есть там, приезжает сюда; расхождение по
 * одному имени — это две версии, а не выбор одной за спиной человека.
 *
 * ── Почему это не очевидно из кода ──────────────────────────────────────────
 *
 * Движок синка помнит по каждому пути `etag` и хеш последнего синхронизиро-
 * ванного содержимого. Эта память — про КОНКРЕТНОГО контрагента: etag папки
 * ничего не значит для облака. Если память переехала на новый бэкенд как своя,
 * логика читается так: «локально не менялось (хеш совпал), на той стороне
 * менялось (etag другой) — значит забираем чужое». И чужое молча ложится
 * поверх своего.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import { SyncEngine } from '../src/sync/engine.js';
import { LocalFolderBackend } from '../src/sync/local-folder.js';
import { Vault } from '../src/vault/vault.js';

const NOTE = 'Идеи.md';
const MINE = '# Идеи\n\nмоя строка\n';
const THEIRS = '# Идеи\n\nчужая строка\n';

function clock(): () => number {
  let now = Date.UTC(2026, 7, 14, 10, 0, 0);
  return () => (now += 1000);
}

/** Устройство с папкой заметок и первым местом синхронизации. */
async function device(now: () => number) {
  const disk = new MemoryVaultStorage({ now });
  const vault = await Vault.open(disk, { now, renameDelayMs: 0 });
  return { disk, vault };
}

describe('переезд с папки в облако', () => {
  it('накопленные заметки уезжают в пустое облако целиком', async () => {
    const now = clock();
    const { disk, vault } = await device(now);
    await vault.write(NOTE, MINE, { scheduleRename: false });
    await vault.write('Планы/Неделя.md', '# Неделя\n\nсписок\n', { scheduleRename: false });

    /* Человек сидел на папке. */
    const folder = new MemoryVaultStorage({ now });
    const first = new SyncEngine(vault, new LocalFolderBackend(folder, { origin: 'папка' }), { now });
    await first.sync();
    expect(Object.keys(folder.snapshot())).toContain(NOTE);

    /* И подключил облако — пустое. */
    const cloud = new MemoryVaultStorage({ now });
    const second = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    const outcome = await second.sync();

    const uploaded = Object.keys(cloud.snapshot());
    expect(uploaded, 'заметки не уехали в облако').toContain(NOTE);
    expect(uploaded).toContain('Планы/Неделя.md');
    expect(outcome.pushed).toBeGreaterThan(0);
    /* И на диске всё осталось как было: переезд — не переселение. */
    expect(disk.snapshot()[NOTE]).toBe(MINE);
  });

  it('чужая версия по тому же имени не ложится поверх моей молча', async () => {
    /* Самый опасный случай и самый обычный: человек уже пользовался облаком с
       другого устройства, и там лежит «Идеи.md» с другим текстом. При первом
       соединении общей истории у сторон нет — значит ни одну версию нельзя
       объявить устаревшей. Обе обязаны уцелеть. */
    const now = clock();
    const { disk, vault } = await device(now);
    await vault.write(NOTE, MINE, { scheduleRename: false });

    const folder = new MemoryVaultStorage({ now });
    const first = new SyncEngine(vault, new LocalFolderBackend(folder, { origin: 'папка' }), { now });
    await first.sync();

    const cloud = new MemoryVaultStorage({ now });
    await cloud.write(NOTE, new TextEncoder().encode(THEIRS));

    const second = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await second.sync();

    const after = disk.snapshot();
    const local = String(after[NOTE]);
    const copies = Object.keys(after).filter((path) => path.startsWith('Идеи'));

    expect(
      local.includes('моя строка') || copies.some((path) => String(after[path]).includes('моя строка')),
      `моя версия исчезла при подключении облака; на диске осталось: ${copies.join(' · ')}`,
    ).toBe(true);
    expect(
      local.includes('чужая строка') || copies.some((path) => String(after[path]).includes('чужая строка')),
      'чужая версия не приехала вовсе',
    ).toBe(true);
  });

  it('удаление на старом месте не увозит заметки с нового', async () => {
    /* Память о синхронизации содержит пути, которых давно нет локально. На
       новом месте они не должны превращаться в команду «удалить». */
    const now = clock();
    const { vault } = await device(now);
    await vault.write('Черновик.md', '# Черновик\n', { scheduleRename: false });

    const folder = new MemoryVaultStorage({ now });
    const first = new SyncEngine(vault, new LocalFolderBackend(folder, { origin: 'папка' }), { now });
    await first.sync();
    await vault.trash('Черновик.md');
    await first.sync();

    /* В облаке та же заметка есть — её туда положило другое устройство. */
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write('Черновик.md', new TextEncoder().encode('# Черновик\n\nс другого устройства\n'));

    const second = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await second.sync();

    expect(
      Object.keys(cloud.snapshot()),
      'подключение облака удалило в нём чужую заметку',
    ).toContain('Черновик.md');
  });
});

/**
 * Вложения уезжают вместе с заметками.
 *
 * ── Что увидел заказчик ─────────────────────────────────────────────────────
 *
 * «Картинки не подгружаются и папок Images, Audio и Other files в принципе
 * нет» — на втором устройстве, куда только что приехали 75 заметок.
 *
 * Причина была в двух местах сразу: движок предлагал к обмену только заметки и
 * CRDT-логи, а признак вложения требовал старый каталог `attachments/`. Файлы
 * из `Images`, `Audio` и `Other files` не проходили ни то ни другое — и текст
 * приезжал со ссылкой на файл, которого на том конце нет.
 */
describe('вложения синхронизируются, а не только текст', () => {
  it('картинка уезжает в облако вместе с заметкой', async () => {
    const now = clock();
    const { disk, vault } = await device(now);
    await vault.write('Идеи.md', '# Идеи\n\n![](Images/схема.png)\n', { scheduleRename: false });
    await disk.write('Images/схема.png', new Uint8Array([1, 2, 3]));

    const cloud = new MemoryVaultStorage({ now });
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await engine.sync();

    expect(
      Object.keys(cloud.snapshot()),
      'заметка уехала, а картинка осталась — на том конце будет ссылка в никуда',
    ).toContain('Images/схема.png');
  });

  it('и приезжает на второе устройство', async () => {
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write('Идеи.md', new TextEncoder().encode('# Идеи\n\n![](Images/схема.png)\n'));
    await cloud.write('Images/схема.png', new Uint8Array([1, 2, 3]));

    const { disk, vault } = await device(now);
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await engine.sync();

    expect(Object.keys(disk.snapshot())).toContain('Images/схема.png');
  });

  it('исполняемое не проходит: белый список — настоящий предохранитель', async () => {
    const now = clock();
    const { disk, vault } = await device(now);
    await vault.write('Идеи.md', '# Идеи\n', { scheduleRename: false });
    await disk.write('Other files/обновление.apk', new Uint8Array([1]));

    const cloud = new MemoryVaultStorage({ now });
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await engine.sync();

    expect(Object.keys(cloud.snapshot())).not.toContain('Other files/обновление.apk');
  });
});

/**
 * Объём хранилища — байты, а не число записей.
 *
 * Заказчик: «показывает 75 заметок и 79 Б». Число было количеством записей в
 * памяти синхронизации, подписанным как байты. Второй счёт, в результате
 * прохода, складывал длины строк: кириллица в UTF-8 занимает по два байта на
 * букву, а вложения в такую сумму не попадали вовсе.
 */
describe('сколько занято в хранилище', () => {
  it('складывает настоящие байты заметок и вложений', async () => {
    const now = clock();
    const { disk, vault } = await device(now);
    const text = '# Идеи\n\nмоя строка\n';
    await vault.write('Идеи.md', text, { scheduleRename: false });
    await disk.write('Images/схема.png', new Uint8Array(2048));

    const cloud = new MemoryVaultStorage({ now });
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    const outcome = await engine.sync();

    const noteBytes = new TextEncoder().encode(text).byteLength;
    expect(
      outcome.bytes,
      'объём посчитан не в байтах: кириллица весит вдвое, а вложение весит вообще',
    ).toBeGreaterThanOrEqual(noteBytes + 2048);
    /* И это не число файлов, замаскированное под байты. */
    expect(outcome.bytes).toBeGreaterThan(1000);
    expect(engine.status().bytes).toBe(outcome.bytes);
  });

  it('картинка не превращается в текст в памяти синхронизации', async () => {
    /* База для diff3 нужна заметкам: без неё правка с двух устройств даёт две
       копии вместо слияния. Вложению она бесполезна и вредна — слить два JPEG
       построчно нельзя, а весит такая «база» столько же, сколько файл. */
    const now = clock();
    const { disk, vault } = await device(now);
    await vault.write('Идеи.md', '# Идеи\n', { scheduleRename: false });
    await disk.write('Images/схема.png', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));

    const cloud = new MemoryVaultStorage({ now });
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await engine.sync();

    const state = JSON.parse(
      new TextDecoder().decode((await disk.read('.zapiski/sync-state.json')) as Uint8Array),
    ) as { remotes: Record<string, { entries: Record<string, { base?: string }> }> };
    const entries = Object.values(state.remotes)[0]?.entries ?? {};
    expect(entries['Images/схема.png']?.base, 'байты картинки легли строкой в состояние синка').toBeUndefined();
    expect(entries['Идеи.md']?.base, 'заметка осталась без базы — слияние правок сломается').toBeTruthy();
  });
});

/**
 * Приехавшее вложение не притворяется заметкой.
 *
 * Заказчик, сразу после первой удачной синхронизации: «в списке появляются
 * изображения в виде заметок. Они потом прячутся, но сначала фрустрируют —
 * кажется фейком».
 *
 * Так и было. Синхронизация после каждого принесённого файла обновляет
 * карточку по этому пути, а чтение заметки не спрашивало, заметка ли это
 * вообще: байты картинки объявлялись markdown-текстом и ложились в индекс.
 * В списке появлялись «заметки» с именем вложения и телом `PNG IHDR…` на
 * сотню тысяч «слов». Исчезали они при следующей полной пересборке индекса —
 * та читает только `.md`, — и человек оставался с ощущением, что приложение
 * показало ему что-то ненастоящее.
 */
describe('вложение — не заметка', () => {
  it('картинка из облака не попадает в список заметок', async () => {
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write('Идеи.md', new TextEncoder().encode('# Идеи\n\n![](Images/схема.png)\n'));
    /* Настоящие байты PNG — ровно те, что заказчик увидел текстом. */
    await cloud.write('Images/схема.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const { disk, vault } = await device(now);
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await engine.sync();

    /* Файл на диске — да; заметка в списке — нет. */
    expect(Object.keys(disk.snapshot())).toContain('Images/схема.png');
    const titles = vault.notes().map((note) => note.title);
    expect(titles, 'картинка показана заметкой сразу после синхронизации').not.toContain('схема');
    expect(
      vault.notes().some((note) => note.path === 'Images/схема.png'),
      'вложение попало в индекс заметок',
    ).toBe(false);
  });

  it('и документ тоже: PDF в списке выглядел как заметка на 124 тысячи слов', async () => {
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write('Идеи.md', new TextEncoder().encode('# Идеи\n'));
    await cloud.write('Other files/2026-08-14_3591d7.pdf', new TextEncoder().encode('%PDF-1.4 …'));

    const { vault } = await device(now);
    const engine = new SyncEngine(vault, new LocalFolderBackend(cloud, { origin: 'облако' }), { now });
    await engine.sync();

    expect(vault.notes().map((note) => note.path)).toEqual(['Идеи.md']);
  });
});
