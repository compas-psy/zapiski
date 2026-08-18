/**
 * Очередь отправки под пачкой правок.
 *
 * Обе проверки здесь появились из одной работы — переезда и удаления ПАПКИ.
 * Пока про папку молчали, очередь видела по одному пути за жест. Как только
 * про неё заговорили, за один жест мыши в очередь стало прилетать по два
 * намерения на каждую заметку внутри плюс по одному на каждое вложение. Это
 * вскрыло в очереди два свойства, которые на одиночном пути не проявлялись.
 *
 *  1. Каждый `enqueue` перезаписывал файл очереди целиком. Сто заметок — четыре
 *     сотни перезаписей растущего JSON, а на Android каждая ещё и обращение к
 *     SAF через IPC. Человек при этом просто тащит папку мышью.
 *  2. Путь, который синхронизация не берёт (чужой файл в удалённой папке),
 *     оставался в очереди навсегда: движок его пропускал, а очередь считала
 *     неотправленным. Значок «есть неотправленное» больше никогда не гас.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import { ChangeQueue } from '../src/sync/queue.js';
import { SyncEngine } from '../src/sync/engine.js';
import { LocalFolderBackend } from '../src/sync/local-folder.js';
import { Vault } from '../src/vault/vault.js';
import { QUEUE_FILE } from '../src/util/path.js';
import type { VaultPath, VaultStorage } from '../src/contract.js';

/**
 * Хранилище, которое считает записи в файл очереди.
 *
 * Считаем `rename`, а не `write`: запись атомарная — байты уходят во временный
 * файл в `.zapiski/tmp`, и только переименование делает их файлом очереди. Со
 * счётом по `write` этот тест однажды уже был зелёным впустую: путь временного
 * файла с именем очереди не совпадает, счётчик оставался нулём, и проверка
 * проходила даже с возвращённым дефектом.
 */
function counting(inner: VaultStorage): VaultStorage & { writes(): number } {
  let writes = 0;
  const proxy: VaultStorage = {
    ...inner,
    list: (path) => inner.list(path),
    read: (path) => inner.read(path),
    stat: (path) => inner.stat(path),
    mkdir: (path) => inner.mkdir(path),
    write: (path, data) => inner.write(path, data),
    remove: (path) => inner.remove(path),
    rename: (from, to) => {
      if (to === QUEUE_FILE) writes += 1;
      return inner.rename(from, to);
    },
  };
  return Object.assign(proxy, { writes: () => writes });
}

describe('очередь: пачка правок — одна запись на диск', () => {
  it('сотня намерений подряд не превращается в сотню перезаписей', async () => {
    const storage = counting(new MemoryVaultStorage({}));
    const queue = new ChangeQueue(storage);

    /* Так это и выглядит в контроллере: цикл по содержимому папки, каждый
       вызов без ожидания. */
    const burst: Array<Promise<void>> = [];
    for (let n = 0; n < 100; n += 1) burst.push(queue.enqueue(`Папка/Заметка ${n}.md`));
    await Promise.all(burst);

    expect(queue.size).toBe(100);
    expect(storage.writes(), 'каждое намерение писало файл очереди отдельно').toBeLessThanOrEqual(2);
  });

  it('склейка ничего не теряет: на диске оказываются все намерения', async () => {
    const storage = new MemoryVaultStorage({});
    const queue = new ChangeQueue(storage);

    await Promise.all([
      queue.enqueue('Работа/Смета.md', 'delete'),
      queue.enqueue('Архив/Работа/Смета.md'),
      queue.enqueue('Работа/Images/схема.png', 'delete'),
    ]);

    /* Читаем именно с диска: очередь ценна тем, что переживает перезапуск. */
    const reloaded = new ChangeQueue(storage);
    await reloaded.load();
    const kinds = new Map(reloaded.list().map((item) => [item.path, item.kind]));
    expect(kinds.get('Работа/Смета.md')).toBe('delete');
    expect(kinds.get('Архив/Работа/Смета.md')).toBe('put');
    expect(kinds.get('Работа/Images/схема.png')).toBe('delete');
  });

  it('правки после записи не теряются: следующая пачка пишется своей записью', async () => {
    const storage = new MemoryVaultStorage({});
    const queue = new ChangeQueue(storage);

    await queue.enqueue('Первая.md');
    await queue.enqueue('Вторая.md', 'delete');

    const reloaded = new ChangeQueue(storage);
    await reloaded.load();
    expect(reloaded.list().map((item) => item.path)).toEqual(['Первая.md', 'Вторая.md']);
  });
});

describe('очередь не держит то, что никогда не уедет', () => {
  it('намерение по чужому файлу движок снимает, а не копит', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Смета.md': '# Смета\n\nчисла\n' } });
    const vault = new Vault(storage);
    await vault.rebuild();
    const engine = new SyncEngine(vault, new LocalFolderBackend(new MemoryVaultStorage({})));
    await engine.sync();

    /*
     * Так это и случается: в удалённой папке лежал файл чужого формата, и
     * удаление папки честно заказало удаление ВСЕГО её содержимого. Синк такие
     * пути не берёт (белый список SEC-023) — но и вечно числить их
     * неотправленными не должен.
     *
     * Расширение выбрано не наугад: `.txt` в белом списке есть, и на нём
     * проверка была бы зелёной впустую.
     */
    const orphan = 'Папка/сборка.exe' as VaultPath;
    await engine.markDeleted(orphan);
    expect(engine.queue.has(orphan)).toBe(true);

    const outcome = await engine.sync();

    expect(engine.queue.has(orphan), 'путь остался бы в очереди навсегда').toBe(false);
    expect(outcome.pending, 'значок «есть неотправленное» больше не погас бы').toBe(0);
    expect(outcome.state).toBe('synced');
  });
});
