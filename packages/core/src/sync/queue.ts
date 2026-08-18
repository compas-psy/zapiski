/**
 * Очередь изменений, переживающая перезапуск (ТЗ §4.3, BEHAVIOR §6
 * «Очередь изменений сохраняется на диск и переживает перезапуск»).
 *
 * Очередь — множество путей, а не журнал операций: повторная правка одного
 * файла не должна раздувать очередь, синку важен только факт «этот путь надо
 * отправить».
 */
import type { VaultPath, VaultStorage } from '../contract.js';
import { normalizePath, QUEUE_FILE } from '../util/path.js';
import { readJson, writeJsonAtomic } from '../vault/atomic.js';

export type ChangeKind = 'put' | 'delete';

export interface QueuedChange {
  path: VaultPath;
  kind: ChangeKind;
  at: number;
}

interface QueueFile {
  version: number;
  changes: QueuedChange[];
}

const QUEUE_VERSION = 1;

export class ChangeQueue {
  private changes = new Map<VaultPath, QueuedChange>();

  constructor(
    private readonly storage: VaultStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    const file = await readJson<QueueFile>(this.storage, QUEUE_FILE);
    this.changes.clear();
    if (!file || file.version !== QUEUE_VERSION || !Array.isArray(file.changes)) return;
    for (const change of file.changes) {
      if (typeof change?.path === 'string') this.changes.set(normalizePath(change.path), change);
    }
  }

  /** Хвост записи: пока он не разрешился, следующая запись не начинается. */
  private writing: Promise<void> = Promise.resolve();
  /** Запись уже назначена и ещё не начала собирать файл. */
  private scheduled = false;

  /**
   * Сохранить очередь на диск — одной записью на пачку правок.
   *
   * Раньше каждый `enqueue` писал файл сам, и на одиночной правке это верно.
   * Но пути меняются пачками: переезд папки ставит по два намерения на КАЖДУЮ
   * заметку внутри, удаление папки — по одному на каждый файл. Сотня заметок
   * превращалась в четыре сотни перезаписей растущего JSON, причём на Android
   * каждая — это ещё и обращение к SAF через IPC. Пользователь при этом просто
   * тащит папку мышью.
   *
   * Склейка безопасна, потому что запись не инкрементальная: файл собирается
   * из текущего состояния в момент записи, а не из аргументов вызова. Значит
   * одна запись после пачки содержит ровно то же, что содержала бы последняя
   * из ста. Хвост `writing` держит записи по одной: два перекрывающихся
   * atomic-write могли бы завершиться в обратном порядке и оставить на диске
   * снимок постарше.
   */
  private flush(): Promise<void> {
    if (!this.scheduled) {
      this.scheduled = true;
      const write = (): Promise<void> => {
        this.scheduled = false;
        const file: QueueFile = { version: QUEUE_VERSION, changes: [...this.changes.values()] };
        return writeJsonAtomic(this.storage, QUEUE_FILE, file);
      };
      /* Обе ветви ведут в `write`: сорвавшаяся запись (диск отключили, места
         нет) не имеет права заклинить очередь навсегда — следующая правка
         обязана попробовать снова. */
      this.writing = this.writing.then(write, write);
    }
    return this.writing;
  }

  async enqueue(path: VaultPath, kind: ChangeKind = 'put'): Promise<void> {
    this.changes.set(normalizePath(path), { path: normalizePath(path), kind, at: this.now() });
    await this.flush();
  }

  async done(path: VaultPath): Promise<void> {
    if (this.changes.delete(normalizePath(path))) await this.flush();
  }

  list(): QueuedChange[] {
    return [...this.changes.values()].sort((a, b) => a.at - b.at);
  }

  get size(): number {
    return this.changes.size;
  }

  has(path: VaultPath): boolean {
    return this.changes.has(normalizePath(path));
  }

  async clear(): Promise<void> {
    this.changes.clear();
    await this.flush();
  }
}
