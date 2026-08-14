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
