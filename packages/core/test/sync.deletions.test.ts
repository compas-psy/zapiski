/**
 * Удаления в облаке: порядок разрешения.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «в нашем облаке практически невозможно удалить ЗАПИСКУ — когда ты
 * удаляешь на андроиде или в Windows, она возвращается при синхронизации».
 * Отдельно про шифрование: «если её удалить, то она вернётся из облака
 * незашифрованной, и заверения о том, что всё шифруется, становятся сказкой».
 *
 * Механика, по исходникам:
 *
 *  1. `SyncEngine.markDeleted` был написан и его не звал НИ ОДИН файл продукта.
 *     Значит удаление никогда не становилось намерением — оставалось молчанием.
 *  2. А молчание движок читает иначе, и правильно: «локально нет, в облаке
 *     есть» — это заметка, заведённая на другом устройстве, её надо СКАЧАТЬ.
 *     Поэтому удалённое возвращалось.
 *  3. Обратная дорога вообще отсутствовала: сервер честно отдавал надгробия
 *     (`blobs.deleted_at` → поле `removed` при `includeDeleted=1`), а клиент их
 *     не спрашивал, ядро не читало, а переходник в `packages/app` выбрасывал.
 *     Три звена, каждое написано, ни одно не соединено.
 *
 * ── Правило, которое здесь сторожится ───────────────────────────────────────
 *
 * Удаление — это НАМЕРЕНИЕ, а не отсутствие файла. Отсутствие само по себе
 * никогда не означает «удалить», иначе первая же недоступная папка стёрла бы
 * облако. А намерение обязано ехать в обе стороны: моё удаление — туда,
 * чужое — сюда, и правка здесь сильнее удаления там.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { LocalFolderBackend } from '../src/sync/local-folder.js';
import { SyncEngine } from '../src/sync/engine.js';
import { catalog } from '../src/i18n/i18n.js';
import type { SyncBackend, VaultPath } from '../src/contract.js';
import { utf8 } from '../src/util/bytes.js';

const ru = catalog('ru');

/** Место с надгробиями — как Облако Записок, только в памяти. */
function withTombstones(
  backend: SyncBackend,
  tombstones: Map<VaultPath, number>,
): SyncBackend & { removals(since: number): Promise<VaultPath[]> } {
  return Object.assign(Object.create(Object.getPrototypeOf(backend) as object) as SyncBackend, backend, {
    async removals(since: number): Promise<VaultPath[]> {
      return [...tombstones.entries()].filter(([, at]) => at > since).map(([path]) => path);
    },
    async remove(path: VaultPath): Promise<void> {
      tombstones.set(path, Date.now());
      await backend.remove(path);
    },
  });
}

async function setup(files: Record<string, string>) {
  const localStorage = new MemoryVaultStorage({ files });
  const remoteStorage = new MemoryVaultStorage({ files });
  const vault = new Vault(localStorage);
  await vault.rebuild();
  const tombstones = new Map<VaultPath, number>();
  const backend = withTombstones(new LocalFolderBackend(remoteStorage), tombstones);
  const engine = new SyncEngine(vault, backend);
  /* Первый проход сводит стороны: дальше у движка есть память, а значит и
     право отличать «удалили» от «ещё не видели». */
  await engine.sync();
  return { localStorage, remoteStorage, vault, engine, tombstones };
}

describe('моё удаление уезжает в облако', () => {
  it('намерение `delete` убирает файл на той стороне', async () => {
    const { localStorage, remoteStorage, engine } = await setup({ 'Смета.md': '# Смета\n\nчисла\n' });

    await localStorage.remove('Смета.md');
    await engine.markDeleted('Смета.md');
    await engine.sync();

    expect(remoteStorage.snapshot()['Смета.md'], 'файл остался в облаке').toBeUndefined();
    expect(localStorage.snapshot()['Смета.md'], 'файл вернулся из облака').toBeUndefined();
  });

  it('шифрование не оставляет в облаке открытый текст', async () => {
    /*
     * Самый дорогой случай. `.md.enc` кладётся рядом, открытый `.md` убирается
     * — и если про второе облако не узнает, оно вернёт открытый текст обратно.
     * Человеку это выглядит как «зашифровал, а заметка снова открытая».
     */
    const { localStorage, remoteStorage, engine } = await setup({ 'Тайна.md': '# Тайна\n\nтекст\n' });

    await localStorage.write('Тайна.md.enc', utf8('ZPSK1|шифротекст'));
    await localStorage.remove('Тайна.md');
    await engine.markDeleted('Тайна.md');
    await engine.markChanged('Тайна.md.enc');
    await engine.sync();

    const remote = remoteStorage.snapshot();
    expect(remote['Тайна.md'], 'открытый текст остался в облаке').toBeUndefined();
    expect(remote['Тайна.md.enc'], 'контейнер не уехал').toBeDefined();
  });

  it('без намерения отсутствие файла НЕ считается удалением', async () => {
    /*
     * Это не недоделка, а предохранитель, и трогать его нельзя. Отсутствие
     * файла — это ещё и «заметка заведена на другом устройстве», и
     * «непримонтированная карта», и «отозванное разрешение к папке». Стоимость
     * ошибки несимметрична: лишняя копия стоит мегабайт, стёртый архив стоит
     * архива.
     */
    const { localStorage, remoteStorage, engine } = await setup({ 'Смета.md': '# Смета\n' });

    await localStorage.remove('Смета.md');
    await engine.sync();

    expect(remoteStorage.snapshot()['Смета.md'], 'облако стёрли без просьбы').toBeDefined();
    expect(localStorage.snapshot()['Смета.md'], 'заметка не вернулась обратно').toBeDefined();
  });
});

describe('чужое удаление приезжает сюда', () => {
  it('надгробие убирает файл, который здесь не менялся', async () => {
    const { localStorage, remoteStorage, engine, tombstones } = await setup({
      'Смета.md': '# Смета\n\nчисла\n',
      'План.md': '# План\n',
    });

    /* Другое устройство удалило заметку: файла в облаке нет, надгробие есть. */
    await remoteStorage.remove('Смета.md');
    tombstones.set('Смета.md', Date.now() + 1);

    const outcome = await engine.sync();

    expect(localStorage.snapshot()['Смета.md'], 'удалённое на другом устройстве осталось').toBeUndefined();
    expect(outcome.removed).toBe(1);
    expect(localStorage.snapshot()['План.md'], 'заодно снесли лишнее').toBeDefined();
  });

  it('правка здесь сильнее удаления там — и об этом говорят словами', async () => {
    const { localStorage, remoteStorage, engine, tombstones } = await setup({
      'Смета.md': '# Смета\n\nчисла\n',
    });

    await localStorage.write('Смета.md', utf8('# Смета\n\nчисла и ещё строка\n'));
    await remoteStorage.remove('Смета.md');
    tombstones.set('Смета.md', Date.now() + 1);

    const outcome = await engine.sync();

    expect(localStorage.snapshot()['Смета.md'], 'правку потеряли').toContain('ещё строка');
    expect(outcome.messages).toContain(ru.errors.deletedElsewhereKept);
    /* И заметка уехала обратно: иначе она осталась бы только здесь. */
    expect(remoteStorage.snapshot()['Смета.md'], 'оставленная заметка не вернулась в облако').toContain(
      'ещё строка',
    );
  });

  it('удалили и вернули на той стороне — надгробие устарело, файл цел', async () => {
    const { localStorage, engine, tombstones } = await setup({ 'Смета.md': '# Смета\n' });

    /* Надгробие есть, но путь в облаке снова живой: значит его вернули. */
    tombstones.set('Смета.md', Date.now() + 1);

    await engine.sync();

    expect(localStorage.snapshot()['Смета.md'], 'живой файл убрали по устаревшему надгробию').toBeDefined();
  });

  it('первый обмен надгробий не применяет: новое устройство не стирает своё', async () => {
    /*
     * Без этой оговорки человек, поставивший приложение на второй компьютер с
     * уже накопленной папкой, получил бы стирание своих файлов по чужим
     * удалениям, которых он никогда не видел.
     */
    const localStorage = new MemoryVaultStorage({ files: { 'Смета.md': '# Смета\n' } });
    const remoteStorage = new MemoryVaultStorage({ files: {} });
    const vault = new Vault(localStorage);
    await vault.rebuild();
    const tombstones = new Map<VaultPath, number>([['Смета.md', 1]]);
    const engine = new SyncEngine(vault, withTombstones(new LocalFolderBackend(remoteStorage), tombstones));

    await engine.sync();

    expect(localStorage.snapshot()['Смета.md'], 'первый же обмен стёр локальный файл').toBeDefined();
  });
});
