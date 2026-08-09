/**
 * `LocalFolderBackend` — просто папка (ТЗ §4.1): в том числе синкаемая
 * сторонним клиентом (приложение Яндекс.Диска, Syncthing). Никакой сети.
 */
import type { RemoteEntry, SyncBackend, VaultPath, VaultStorage } from '../contract.js';
import { isMetaPath, normalizePath, CRDT_DIR } from '../util/path.js';
import { writeAtomic } from '../vault/atomic.js';

export interface LocalFolderOptions {
  title?: string;
  /** Синкать ли служебные CRDT-логи — нужно для three-way merge (ТЗ §4.2). */
  includeCrdt?: boolean;
}

export class LocalFolderBackend implements SyncBackend {
  readonly id = 'local' as const;
  readonly title: string;
  private readonly includeCrdt: boolean;

  constructor(
    private readonly storage: VaultStorage,
    options: LocalFolderOptions = {},
  ) {
    this.title = options.title ?? 'Локальная папка';
    this.includeCrdt = options.includeCrdt ?? true;
  }

  private syncable(path: VaultPath): boolean {
    if (!isMetaPath(path)) return true;
    return this.includeCrdt && (path === CRDT_DIR || path.startsWith(`${CRDT_DIR}/`));
  }

  async list(): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    const walk = async (dir: VaultPath): Promise<void> => {
      for (const entry of await this.storage.list(dir).catch(() => [])) {
        if (!this.syncable(entry.path)) continue;
        if (entry.isDirectory) {
          await walk(entry.path);
          continue;
        }
        const stat = await this.storage.stat(entry.path);
        if (!stat) continue;
        out.push({ path: entry.path, etag: etagOf(stat.mtime, stat.size), mtime: stat.mtime, size: stat.size });
      }
    };
    await walk('');
    return out;
  }

  async get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null> {
    const normalized = normalizePath(path);
    const data = await this.storage.read(normalized);
    if (data === null) return null;
    const stat = await this.storage.stat(normalized);
    return { data, etag: etagOf(stat?.mtime ?? 0, stat?.size ?? data.length) };
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    const normalized = normalizePath(path);
    if (ifMatch !== undefined) {
      const stat = await this.storage.stat(normalized);
      const current = stat ? etagOf(stat.mtime, stat.size) : '';
      // Оптимистическая блокировка: контрагент успел изменить файл — не затираем.
      if (current !== '' && current !== ifMatch) throw new PreconditionFailed(normalized, current);
    }
    // Атомарно: прерывание на любом байте не портит файл (ТЗ §4.3).
    await writeAtomic(this.storage, normalized, data);
    const stat = await this.storage.stat(normalized);
    return { etag: etagOf(stat?.mtime ?? 0, stat?.size ?? data.length) };
  }

  async remove(path: VaultPath): Promise<void> {
    await this.storage.remove(normalizePath(path)).catch(() => undefined);
  }
}

export class PreconditionFailed extends Error {
  constructor(
    readonly path: VaultPath,
    readonly currentEtag: string,
  ) {
    super(`Файл изменился на стороне контрагента: ${path}`);
    this.name = 'PreconditionFailed';
  }
}

export function etagOf(mtime: number, size: number): string {
  return `${mtime.toString(36)}-${size.toString(36)}`;
}
