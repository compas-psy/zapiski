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

  private async flush(): Promise<void> {
    const file: QueueFile = { version: QUEUE_VERSION, changes: [...this.changes.values()] };
    await writeJsonAtomic(this.storage, QUEUE_FILE, file);
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
