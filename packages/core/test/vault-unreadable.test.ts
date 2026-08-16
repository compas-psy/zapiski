/**
 * «Снова утро, снова пустота»: нечитаемая папка — не пустая папка.
 *
 * ── Что происходило у заказчика ─────────────────────────────────────────────
 *
 * Три утра подряд приложение открывалось с пустым списком, хотя заметки лежали
 * в папке. Утро — это холодный старт: ночью Android убил процесс. На Android
 * папка живёт за системным провайдером (свой у карты памяти, свой у клиента
 * Яндекс.Диска), и на холодном старте провайдер может быть ещё не поднят —
 * запрос содержимого возвращает не ошибку, а ничто.
 *
 * Дальше всё делали мы сами. Обход папки глушил неудачу (`catch(() => [])`),
 * ноль файлов принимался за правду, индекс перестраивался пустым и пустым же
 * СОХРАНЯЛСЯ поверх прежнего. Человек видел «пока нет заметок» — утверждение,
 * которого никто не проверял, и которое было ложным.
 *
 * Здесь проверяется единственное правило: молчание провайдера не превращается
 * ни в пустой список, ни тем более в пустой снапшот на диске.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import type { VaultPath, VaultStorage } from '../src/contract.js';
import { Vault } from '../src/vault/vault.js';

const INDEX_FILE = '.zapiski/index.json';

/** Хранилище, у которого можно «уронить провайдера» на любом обходе. */
function flaky(inner: MemoryVaultStorage): VaultStorage & { silent: boolean } {
  const wrapper = {
    silent: false,
    read: (path: VaultPath) => inner.read(path),
    write: (path: VaultPath, data: Uint8Array) => inner.write(path, data),
    remove: (path: VaultPath) => inner.remove(path),
    rename: (from: VaultPath, to: VaultPath) => inner.rename(from, to),
    stat: (path: VaultPath) => inner.stat(path),
    mkdir: (dir: VaultPath) => inner.mkdir(dir),
    async list(dir: VaultPath) {
      /* Так это и выглядит со стороны JS: провайдер не ответил, и вызов
         заканчивается отказом, а не пустым списком. */
      if (wrapper.silent) throw new Error('провайдер документов не ответил');
      return inner.list(dir);
    },
  };
  return wrapper;
}

async function vaultWithNotes() {
  const disk = new MemoryVaultStorage();
  const storage = flaky(disk);
  const vault = await Vault.open(storage, { renameDelayMs: 0 });
  await vault.write('Идеи.md', '# Идеи\n\nтекст\n', { scheduleRename: false });
  await vault.write('Планы/Неделя.md', '# Неделя\n', { scheduleRename: false });
  await vault.persist();
  return { disk, storage, vault };
}

describe('папку не прочитать — списку заметок верить нельзя', () => {
  it('на холодном старте показывается прежний список, а не пустота', async () => {
    const { disk, storage } = await vaultWithNotes();
    storage.silent = true;

    const morning = await Vault.open(storage, { renameDelayMs: 0 });

    expect(
      morning.unreadable,
      'приложение считает, что список заметок достоверен, хотя папка молчала',
    ).toBe(true);
    expect(
      morning.notes().map((note) => note.path).sort(),
      'заметки объявлены несуществующими из-за одного неотвеченного запроса',
    ).toEqual(['Идеи.md', 'Планы/Неделя.md']);
    /* И снапшот на диске цел: пустой список туда не попал. */
    const kept = JSON.parse(String(disk.snapshot()[INDEX_FILE])) as { mtimes: Record<string, number> };
    expect(Object.keys(kept.mtimes).length, 'пустой индекс записан поверх настоящего').toBe(2);
  });

  it('провайдер очнулся — список возвращается сам', async () => {
    const { storage } = await vaultWithNotes();
    storage.silent = true;
    const morning = await Vault.open(storage, { renameDelayMs: 0 });
    expect(morning.unreadable).toBe(true);

    storage.silent = false;
    await morning.open();

    expect(morning.unreadable, 'признак недоступности не снялся после удачного обхода').toBe(false);
    expect(morning.notes()).toHaveLength(2);
  });

  it('перестройка индекса при молчащей папке ничего не стирает', async () => {
    /* `rebuild()` зовётся не только при открытии: его дёргает пересмотр папки
       при возвращении к приложению. Один неудачный обход в этот момент раньше
       стирал индекс так же надёжно, как и на старте. */
    const { disk, storage, vault } = await vaultWithNotes();
    storage.silent = true;

    await vault.rebuild();

    expect(vault.notes(), 'пересмотр стёр список из-за неотвеченного запроса').toHaveLength(2);
    const kept = JSON.parse(String(disk.snapshot()[INDEX_FILE])) as { mtimes: Record<string, number> };
    expect(Object.keys(kept.mtimes).length).toBe(2);
  });

  it('обход ответил, а файлы не читаются — список тоже не обнуляется', async () => {
    /*
     * Второй способ получить пустой экран при целом хранилище, и он не
     * гипотетический: провайдер отвечает на «что лежит в папке» раньше, чем на
     * «отдай содержимое файла». Тогда обход возвращает 75 имён, чтение — ни
     * одного байта, и индекс перестраивается пустым при живой папке.
     */
    const disk = new MemoryVaultStorage();
    const storage = flaky(disk);
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    await vault.write('Идеи.md', '# Идеи\n\nтекст\n', { scheduleRename: false });
    await vault.persist();

    const mute = { ...storage, read: async () => null } as VaultStorage;
    const morning = await Vault.open(mute, { renameDelayMs: 0 });

    /*
     * Показать нечего: снапшот индекса лежит в той же папке и не читается тоже.
     * Но и утверждать «заметок нет» нельзя — а именно это приложение делало,
     * потому что отличить не умело. Признак недоступности здесь и есть вся
     * разница между «мы не знаем» и «у вас пусто».
     */
    expect(morning.unreadable, 'молчащее чтение принято за отсутствие заметок').toBe(true);
    /* И снапшот на диске цел: следующий запуск начнётся не с нуля. */
    const kept = JSON.parse(String(disk.snapshot()[INDEX_FILE])) as { mtimes: Record<string, number> };
    expect(Object.keys(kept.mtimes), 'пустой индекс записан поверх настоящего').toEqual(['Идеи.md']);
  });

  it('пустая папка остаётся пустой папкой — без ложной тревоги', async () => {
    /* Обратная сторона: первый запуск на чистом хранилище обязан выглядеть
       ровно как пустое хранилище, иначе человек получит «папка недоступна» на
       ровном месте. */
    const storage = flaky(new MemoryVaultStorage());
    const fresh = await Vault.open(storage, { renameDelayMs: 0 });

    expect(fresh.unreadable).toBe(false);
    expect(fresh.notes()).toHaveLength(0);
  });
});

/**
 * Выбранная папка не открывалась из-за ремонтной операции.
 *
 * Заказчик, Android: выбрал системным окном свою папку `Zapiski`, приложение
 * ответило «Папка недоступна», а в настройках осталось прежнее «Записки» —
 * имя каталога приложения там, где он только что указал свой. Расхождение имён
 * он и заметил.
 *
 * Причина: доигрывание прерванного переименования стояло ПЕРВОЙ строкой
 * `Vault.open` и бросало наружу. Вызывающий трактует любое исключение как
 * «папка недоступна», поэтому свежая пустая папка объявлялась сломанной.
 */
describe('ремонтная операция не отменяет открытие', () => {
  it('журнал переименования не читается — хранилище всё равно открывается', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Заметка.md': '# Заметка\n' } });
    const original = storage.read.bind(storage);
    storage.read = async (path) => {
      /* Ровно то, что делает мост SAF на свежей папке: отказ вместо «нет
         файла». Отказ на журнале не должен стоить человеку хранилища. */
      if (path.includes('rename')) throw new Error('мост отказал');
      return original(path);
    };

    const vault = await Vault.open(storage);

    expect(vault.notes().map((note) => note.path)).toContain('Заметка.md');
  });
});
