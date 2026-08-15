/**
 * Обещание local-first: облако — удобство, а не условие работы.
 *
 * ── Запрос заказчика дословно ───────────────────────────────────────────────
 *
 * «Проверь, чтобы было так: если раз синхронизировалось и сохранилось локально,
 * чтобы было доступно, даже при отсутствии подключения к облаку. Работаем
 * локально, пока облако не подключится. А дальше, если локально накопились
 * записки/изменения, то после переключения в онлайн в работу вступает механизм
 * синхронизации с разрешением конфликтов, который ты делал в начале».
 *
 * Три отдельных обещания, и здесь каждое проверяется отдельно:
 *
 *  1. приехавшее из облака лежит на диске обычными файлами и читается без
 *     всякой сети — в том числе после перезапуска приложения;
 *  2. пока облако недоступно, работа идёт как обычно: правки пишутся, новые
 *     заметки создаются, отказ синка не превращается в отказ продукта;
 *  3. когда связь вернулась, накопленное уезжает, а встречная правка не
 *     затирает свою: сходятся тексты, а при неразрешимом расхождении обе
 *     версии остаются видимыми.
 *
 * Проверки фальсифицируемы: каждая падает, если поведение вернуть назад.
 * Например, третья группа перестанет проходить, если движок начнёт при
 * встречной правке просто забирать чужое.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import type { RemoteEntry, SyncBackend, VaultPath } from '../src/contract.js';
import { SyncEngine } from '../src/sync/engine.js';
import { LocalFolderBackend } from '../src/sync/local-folder.js';
import { SyncError } from '../src/sync/webdav.js';
import { Vault } from '../src/vault/vault.js';

function clock(): () => number {
  let now = Date.UTC(2026, 7, 15, 9, 0, 0);
  return () => (now += 1000);
}

/**
 * Облако, которое умеет пропадать.
 *
 * Обёртка вокруг обычного бэкенда: пока `online` — всё как всегда, иначе
 * каждый вызов отвечает `unreachable`. Именно так выглядит для движка
 * телефон в метро, отозванный вход и упавший сервер: он знает не «почему»,
 * а «не дозвонился».
 */
class FlakyCloud implements SyncBackend {
  readonly id = 'local' as const;
  readonly title = 'Облако Записок';
  readonly origin = 'облако';
  online = true;

  constructor(private readonly inner: LocalFolderBackend) {}

  private guard(): void {
    if (!this.online) throw new SyncError('нет связи', 'unreachable');
  }

  async list(): Promise<RemoteEntry[]> {
    this.guard();
    return this.inner.list();
  }

  async get(path: VaultPath) {
    this.guard();
    return this.inner.get(path);
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string) {
    this.guard();
    return ifMatch === undefined ? this.inner.put(path, data) : this.inner.put(path, data, ifMatch);
  }

  async remove(path: VaultPath): Promise<void> {
    this.guard();
    await this.inner.remove(path);
  }
}

/** Устройство: диск, хранилище заметок и движок к общему облаку. */
async function device(cloud: MemoryVaultStorage, now: () => number) {
  const disk = new MemoryVaultStorage({ now });
  const vault = await Vault.open(disk, { now, renameDelayMs: 0 });
  const backend = new FlakyCloud(new LocalFolderBackend(cloud, { origin: 'облако' }));
  /* Сеть — знание оболочки: движок отличает «нет сети» от «не дозвонился»
     только потому, что кто-то отвечает на этот вопрос за него. */
  const engine = new SyncEngine(vault, backend, { now, isOnline: () => backend.online });
  return { disk, vault, backend, engine };
}

const IDEAS = 'Идеи.md';

describe('засинхронизированное доступно без облака', () => {
  it('заметки из облака остаются на диске и читаются, когда связи нет', async () => {
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write(IDEAS, new TextEncoder().encode('# Идеи\n\nпервая строка\n'));
    await cloud.write('Планы/Неделя.md', new TextEncoder().encode('# Неделя\n\nсписок\n'));

    const one = await device(cloud, now);
    await one.engine.sync();

    /* Связь пропала — вместе с ней не должно пропасть ничего. */
    one.backend.online = false;

    expect(
      one.vault.notes().map((note) => note.path).sort(),
      'заметки исчезли из списка вместе со связью',
    ).toEqual([IDEAS, 'Планы/Неделя.md']);
    const body = await one.vault.read(IDEAS);
    expect(body?.body, 'текст заметки недоступен без облака').toContain('первая строка');
  });

  it('и переживают перезапуск приложения без единого обращения к сети', async () => {
    /* Ровно то, что заказчик увидел иначе: «сегодня вновь открыл приложение, и
       файлы исчезли». Индекс собирается с диска, а не из облака, поэтому
       второй запуск обязан показать то же самое даже при мёртвой связи. */
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write(IDEAS, new TextEncoder().encode('# Идеи\n\nпервая строка\n'));

    const one = await device(cloud, now);
    await one.engine.sync();
    one.backend.online = false;

    const again = await Vault.open(one.disk, { now, renameDelayMs: 0 });
    expect(
      again.notes().map((note) => note.path),
      'после перезапуска без связи список пуст — заметки выглядят потерянными',
    ).toEqual([IDEAS]);
  });
});

describe('работаем локально, пока облако не подключится', () => {
  it('правка и новая заметка сохраняются, а отказ синка остаётся статусом', async () => {
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write(IDEAS, new TextEncoder().encode('# Идеи\n\nпервая строка\n'));

    const one = await device(cloud, now);
    await one.engine.sync();
    one.backend.online = false;

    await one.vault.write(IDEAS, '# Идеи\n\nпервая строка\nдописано в дороге\n', {
      scheduleRename: false,
    });
    await one.engine.markChanged(IDEAS);
    await one.vault.write('В дороге.md', '# В дороге\n\nсочинилось\n', { scheduleRename: false });
    await one.engine.markChanged('В дороге.md');

    const outcome = await one.engine.sync();

    /* Отказ назван своим словом и НЕ ошибкой продукта: сети нет — это «Оффлайн
       · всё сохранено локально», а не «Не удалось соединиться». */
    expect(outcome.state, 'недоступное облако объявлено сбоем').toBe('offline');
    expect(outcome.error).toBe('Оффлайн · всё сохранено локально');

    /* Написанное — на диске, где ему и место. */
    const disk = one.disk.snapshot();
    expect(String(disk[IDEAS])).toContain('дописано в дороге');
    expect(Object.keys(disk), 'новая заметка не сохранилась без облака').toContain('В дороге.md');

    /* И оба изменения помнятся как неотправленные: это и есть «накопились». */
    expect(one.engine.queue.has(IDEAS)).toBe(true);
    expect(one.engine.queue.has('В дороге.md')).toBe(true);
  });

  it('очередь неотправленного переживает перезапуск', async () => {
    /* BEHAVIOR §6: очередь изменений сохраняется на диск. Без этого «накопились
       локально» живёт до первого закрытия приложения, а человеку обещано
       обратное. */
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    const one = await device(cloud, now);
    await one.vault.write('Черновик.md', '# Черновик\n', { scheduleRename: false });
    one.backend.online = false;
    await one.engine.markChanged('Черновик.md');

    const vaultAgain = await Vault.open(one.disk, { now, renameDelayMs: 0 });
    const backend = new FlakyCloud(new LocalFolderBackend(cloud, { origin: 'облако' }));
    const engineAgain = new SyncEngine(vaultAgain, backend, { now });
    await engineAgain.load();

    expect(
      engineAgain.queue.has('Черновик.md'),
      'после перезапуска приложение забыло, что заметку ещё не отправляли',
    ).toBe(true);
  });
});

describe('связь вернулась — вступает синхронизация с разрешением конфликтов', () => {
  it('накопленное уезжает в облако целиком', async () => {
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    await cloud.write(IDEAS, new TextEncoder().encode('# Идеи\n\nпервая строка\n'));

    const one = await device(cloud, now);
    await one.engine.sync();
    one.backend.online = false;

    await one.vault.write(IDEAS, '# Идеи\n\nпервая строка\nдописано в дороге\n', {
      scheduleRename: false,
    });
    await one.engine.markChanged(IDEAS);
    await one.vault.write('В дороге.md', '# В дороге\n\nсочинилось\n', { scheduleRename: false });
    await one.engine.markChanged('В дороге.md');
    await one.engine.sync();

    one.backend.online = true;
    const outcome = await one.engine.sync();

    const uploaded = cloud.snapshot();
    expect(String(uploaded[IDEAS]), 'правка, сделанная офлайн, не уехала').toContain(
      'дописано в дороге',
    );
    expect(
      Object.keys(uploaded),
      'заметка, написанная офлайн, осталась только на устройстве',
    ).toContain('В дороге.md');
    expect(outcome.state).not.toBe('error');
    expect(one.engine.queue.size, 'очередь не разобрана после удачного прохода').toBe(0);
  });

  it('встречная правка сливается, а не затирает мою', async () => {
    /* Пока телефон был без связи, второе устройство дописало ту же заметку с
       другого конца. Обе правки обязаны уцелеть — это тот самый «механизм с
       разрешением конфликтов», ради которого писались CRDT и diff3. */
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    const base = '# Идеи\n\nпервая строка\nвторая строка\nтретья строка\n';
    await cloud.write(IDEAS, new TextEncoder().encode(base));

    const one = await device(cloud, now);
    await one.engine.sync();
    one.backend.online = false;

    /* Моя правка — в конце текста. */
    await one.vault.write(IDEAS, `${base}моя строка из метро\n`, { scheduleRename: false });
    await one.engine.markChanged(IDEAS);
    await one.engine.sync();

    /* Чужая — в начале, и она уже в облаке. */
    await cloud.write(IDEAS, new TextEncoder().encode(base.replace('первая строка', 'первая строка (правка с ноутбука)')));

    one.backend.online = true;
    await one.engine.sync();

    const local = String(one.disk.snapshot()[IDEAS]);
    const remote = String(cloud.snapshot()[IDEAS]);
    expect(local, 'моя правка потерялась при возвращении связи').toContain('моя строка из метро');
    expect(local, 'чужая правка не приехала').toContain('правка с ноутбука');
    expect(remote, 'облако не узнало о моей правке').toContain('моя строка из метро');
    expect(remote).toContain('правка с ноутбука');
  });

  it('неразрешимое расхождение сохраняет обе версии, а не выбирает за человека', async () => {
    /* Одна и та же строка переписана с двух сторон по-разному. Слить это
       нельзя — можно только сохранить обе версии: своя на месте, чужая в
       истории (ТЗ §2.1.4, §4.2). Молчаливый выбор одной из них — потеря
       данных, как её ни назови. */
    const now = clock();
    const cloud = new MemoryVaultStorage({ now });
    const base = '# Идеи\n\nстрока которую перепишут\n';
    await cloud.write(IDEAS, new TextEncoder().encode(base));

    const one = await device(cloud, now);
    /* CRDT здесь выключен намеренно: заметку правили СТОРОННИМ редактором с
       обеих сторон, логов нет, и остаётся построчный diff3 — самый суровый
       путь из трёх. */
    const backend = new FlakyCloud(new LocalFolderBackend(cloud, { origin: 'облако' }));
    const engine = new SyncEngine(one.vault, backend, {
      now,
      syncCrdt: false,
      isOnline: () => backend.online,
    });
    await engine.sync();

    backend.online = false;
    await one.vault.write(IDEAS, '# Идеи\n\nмоя версия строки\n', { scheduleRename: false });
    await engine.markChanged(IDEAS);
    await engine.sync();

    await cloud.write(IDEAS, new TextEncoder().encode('# Идеи\n\nчужая версия строки\n'));
    backend.online = true;
    const outcome = await engine.sync();

    const local = String(one.disk.snapshot()[IDEAS]);
    const noteId = one.vault.metaOf(IDEAS)?.id ?? 'Идеи';
    const history = await engine.versions.list(noteId);
    const texts = [local, ...history.map((snapshot) => snapshot.body)].join('\n');

    expect(outcome.conflicts, 'расхождение не признано конфликтом').toBeGreaterThan(0);
    expect(texts, 'моя версия строки исчезла').toContain('моя версия строки');
    expect(texts, 'чужая версия строки исчезла').toContain('чужая версия строки');
  });
});
