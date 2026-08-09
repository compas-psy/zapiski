/**
 * `VaultStorage` в памяти (contract.ts §Порты).
 *
 * Две задачи: тесты ядра и запуск UI без настоящей ФС (веб-демо, сторибук).
 * Семантика повторяет файловую: каталоги существуют явно, `rename` атомарен,
 * запись в несуществующий каталог создаёт его (как `mkdir -p` в реализациях
 * поверх Tauri FS и OPFS).
 */
import type { VaultEntry, VaultPath, VaultStat, VaultStorage } from './contract.js';
import { ancestorDirs, baseName, dirName, normalizePath } from './util/path.js';

interface MemoryFile {
  data: Uint8Array;
  mtime: number;
}

export interface MemoryVaultStorageOptions {
  /** Стартовое содержимое: путь → строка или байты. */
  files?: Record<string, string | Uint8Array>;
  /** Управляемое время — чтобы тесты не зависели от часов устройства (ТЗ §4.3). */
  now?: () => number;
}

export class MemoryVaultStorage implements VaultStorage {
  private files = new Map<VaultPath, MemoryFile>();
  private dirs = new Set<VaultPath>();
  private readonly now: () => number;

  /** Счётчики обращений — используются в перф- и синк-тестах. */
  readonly stats = { reads: 0, writes: 0, renames: 0, removes: 0 };

  /**
   * Инъекция сбоя: если задано, следующая запись по этому пути бросит.
   * Нужна для проверки транзакционности переименования (BEHAVIOR §2.2).
   */
  failWriteAt: VaultPath | null = null;
  /** Инъекция сбоя на N-й записи (1 — на первой). */
  failWriteAfter: number | null = null;

  constructor(options: MemoryVaultStorageOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    for (const [path, content] of Object.entries(options.files ?? {})) {
      const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      this.writeSync(normalizePath(path), data);
    }
  }

  private writeSync(path: VaultPath, data: Uint8Array): void {
    for (const dir of ancestorDirs(dirName(path))) this.dirs.add(dir);
    this.files.set(path, { data: new Uint8Array(data), mtime: this.now() });
  }

  async read(path: VaultPath): Promise<Uint8Array | null> {
    this.stats.reads += 1;
    const file = this.files.get(normalizePath(path));
    return file ? new Uint8Array(file.data) : null;
  }

  async write(path: VaultPath, data: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    if (this.failWriteAt !== null && normalizePath(this.failWriteAt) === normalized) {
      throw new Error(`MemoryVaultStorage: инъекция сбоя записи ${normalized}`);
    }
    if (this.failWriteAfter !== null) {
      this.failWriteAfter -= 1;
      if (this.failWriteAfter < 0) throw new Error('MemoryVaultStorage: инъекция сбоя записи');
    }
    this.stats.writes += 1;
    this.writeSync(normalized, data);
  }

  async remove(path: VaultPath): Promise<void> {
    const normalized = normalizePath(path);
    this.stats.removes += 1;
    if (this.files.delete(normalized)) return;
    // Удаление каталога — рекурсивно, как `rm -r` в платформенных реализациях.
    if (this.dirs.delete(normalized)) {
      const prefix = `${normalized}/`;
      for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
      for (const key of [...this.dirs]) if (key.startsWith(prefix)) this.dirs.delete(key);
    }
  }

  async rename(from: VaultPath, to: VaultPath): Promise<void> {
    const src = normalizePath(from);
    const dst = normalizePath(to);
    this.stats.renames += 1;
    const file = this.files.get(src);
    if (file) {
      this.files.delete(src);
      for (const dir of ancestorDirs(dirName(dst))) this.dirs.add(dir);
      this.files.set(dst, file);
      return;
    }
    if (!this.dirs.has(src)) throw new Error(`MemoryVaultStorage: нет такого пути ${src}`);
    const prefix = `${src}/`;
    for (const [key, value] of [...this.files]) {
      if (key.startsWith(prefix)) {
        this.files.delete(key);
        this.files.set(dst + key.slice(src.length), value);
      }
    }
    for (const key of [...this.dirs]) {
      if (key === src || key.startsWith(prefix)) {
        this.dirs.delete(key);
        this.dirs.add(dst + key.slice(src.length));
      }
    }
    for (const dir of ancestorDirs(dst)) this.dirs.add(dir);
  }

  async list(dir: VaultPath): Promise<VaultEntry[]> {
    const base = normalizePath(dir);
    const prefix = base === '' ? '' : `${base}/`;
    const seen = new Map<VaultPath, VaultEntry>();
    const collect = (path: VaultPath, isDirectory: boolean): void => {
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length);
      if (rest === '') return;
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const childPath = prefix + name;
      if (seen.has(childPath)) return;
      seen.set(childPath, { path: childPath, name, isDirectory: slash !== -1 ? true : isDirectory });
    };
    for (const path of this.files.keys()) collect(path, false);
    for (const path of this.dirs) collect(path, true);
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  async stat(path: VaultPath): Promise<VaultStat | null> {
    const normalized = normalizePath(path);
    const file = this.files.get(normalized);
    if (file) return { size: file.data.length, mtime: file.mtime };
    if (this.dirs.has(normalized)) return { size: 0, mtime: 0 };
    return null;
  }

  async mkdir(dir: VaultPath): Promise<void> {
    for (const path of ancestorDirs(dir)) this.dirs.add(path);
  }

  // ── Только для тестов и отладки ────────────────────────────────────────────

  /** Снимок всех файлов: путь → текст. Каталоги не включаются. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    const decoder = new TextDecoder();
    for (const [path, file] of [...this.files].sort((a, b) => a[0].localeCompare(b[0]))) {
      out[path] = decoder.decode(file.data);
    }
    return out;
  }

  /** Все пути файлов, включая служебные. */
  paths(): VaultPath[] {
    return [...this.files.keys()].sort();
  }

  /** Есть ли где-нибудь на «диске» эта подстрока — проверка отсутствия plaintext. */
  containsPlaintext(needle: string): boolean {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    for (const file of this.files.values()) {
      if (decoder.decode(file.data).includes(needle)) return true;
    }
    return false;
  }

  /** Глубокая копия — эмуляция «другого устройства» с тем же начальным vault'ом. */
  clone(): MemoryVaultStorage {
    const copy = new MemoryVaultStorage({ now: this.now });
    for (const [path, file] of this.files) copy.files.set(path, { data: new Uint8Array(file.data), mtime: file.mtime });
    for (const dir of this.dirs) copy.dirs.add(dir);
    return copy;
  }

  get fileCount(): number {
    return this.files.size;
  }

  nameOf(path: VaultPath): string {
    return baseName(path);
  }
}
