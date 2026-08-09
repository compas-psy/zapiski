/**
 * Движок синхронизации (ТЗ §4.2, §4.3; BEHAVIOR §6).
 *
 * Свойства, которые здесь обеспечиваются:
 *  • очередь изменений переживает перезапуск (`ChangeQueue`);
 *  • прерывание на любом байте не портит файл (атомарная запись);
 *  • конфликты не теряют данные никогда (ТЗ §2.1.4): сначала CRDT-слияние,
 *    затем diff3, при неразрешимости обе версии сохраняются, чужая уходит
 *    в историю версий;
 *  • в гибридном режиме облачная версия главная, снапшот локальной уходит
 *    в историю;
 *  • зашифрованные `.md.enc` не сливаются никогда — сохраняются обе версии
 *    (BEHAVIOR §5.4).
 */
import type { NoteId, SyncBackend, SyncStatus, VaultPath, VaultStorage } from '../contract.js';
import { CrdtStore } from '../crdt/store.js';
import { NoteDoc } from '../crdt/doc.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { fnv1a, fromUtf8, utf8 } from '../util/bytes.js';
import { CRDT_DIR, dirName, isEncryptedPath, isMetaPath, META_DIR, normalizePath, stemOf } from '../util/path.js';
import { readJson, writeAtomic, writeJsonAtomic } from '../vault/atomic.js';
import type { Vault } from '../vault/vault.js';
import { diff3 } from './diff3.js';
import { ChangeQueue } from './queue.js';
import { VersionHistory } from './versions.js';
import { PreconditionFailed } from './local-folder.js';
import { SyncError } from './webdav.js';

const STATE_FILE = `${META_DIR}/sync-state.json`;

/** Заметки синкаются раньше служебных CRDT-логов. */
function byNotesFirst(a: VaultPath, b: VaultPath): number {
  const left = a.startsWith(`${CRDT_DIR}/`) ? 1 : 0;
  const right = b.startsWith(`${CRDT_DIR}/`) ? 1 : 0;
  return left - right || a.localeCompare(b);
}
const STATE_VERSION = 1;

interface SyncEntryState {
  etag: string;
  /** Текст, на котором стороны сошлись в прошлый раз — база для diff3. */
  base?: string;
  baseHash: number;
  syncedAt: number;
}

interface SyncStateFile {
  version: number;
  lastSyncAt: number | null;
  entries: Record<VaultPath, SyncEntryState>;
}

export type SyncMode = 'hybrid' | 'peer';

export interface SyncEngineOptions {
  deviceName?: string;
  locale?: Locale;
  now?: () => number;
  /** Гибридный режим: облачная версия главная (ТЗ §4.2). */
  mode?: SyncMode;
  /** Синкать ли CRDT-логи — нужно для three-way merge. */
  syncCrdt?: boolean;
}

export interface SyncOutcome extends SyncStatus {
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
  /** Тексты для тостов — строго из реестра BEHAVIOR §11. */
  messages: string[];
}

export class SyncEngine {
  readonly queue: ChangeQueue;
  readonly versions: VersionHistory;
  private readonly crdt: CrdtStore;
  private readonly storage: VaultStorage;
  private readonly deviceName: string;
  private readonly locale: Locale;
  private readonly now: () => number;
  private readonly mode: SyncMode;
  private readonly syncCrdt: boolean;
  private state: SyncStateFile = { version: STATE_VERSION, lastSyncAt: null, entries: {} };
  private loaded = false;
  private running: Promise<SyncOutcome> | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly backend: SyncBackend,
    options: SyncEngineOptions = {},
  ) {
    this.storage = vault.storage;
    this.deviceName = options.deviceName ?? 'local';
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.now = options.now ?? (() => Date.now());
    this.mode = options.mode ?? 'peer';
    this.syncCrdt = options.syncCrdt ?? true;
    this.queue = new ChangeQueue(this.storage, this.now);
    this.versions = new VersionHistory(this.storage, this.now);
    this.crdt = new CrdtStore(this.storage, this.deviceName);
  }

  private get strings() {
    return catalog(this.locale);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.queue.load();
    const file = await readJson<SyncStateFile>(this.storage, STATE_FILE);
    if (file && file.version === STATE_VERSION && file.entries) this.state = file;
    this.loaded = true;
  }

  private async saveState(): Promise<void> {
    await writeJsonAtomic(this.storage, STATE_FILE, this.state);
  }

  /** Регистрация локального изменения (автосохранение → debounce 5 с, BEHAVIOR §6). */
  async markChanged(path: VaultPath): Promise<void> {
    await this.load();
    await this.queue.enqueue(normalizePath(path), 'put');
  }

  async markDeleted(path: VaultPath): Promise<void> {
    await this.load();
    await this.queue.enqueue(normalizePath(path), 'delete');
  }

  status(): SyncStatus {
    const notes = this.vault.notes();
    return {
      state: this.queue.size > 0 ? 'syncing' : 'synced',
      lastSyncAt: this.state.lastSyncAt,
      noteCount: notes.length,
      bytes: Object.keys(this.state.entries).length,
    };
  }

  /** Один проход синка. Параллельные вызовы разделяют один проход. */
  async sync(): Promise<SyncOutcome> {
    if (this.running) return this.running;
    this.running = this.runSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSync(): Promise<SyncOutcome> {
    await this.load();
    const outcome: SyncOutcome = {
      state: 'synced',
      lastSyncAt: this.state.lastSyncAt,
      noteCount: 0,
      bytes: 0,
      pushed: 0,
      pulled: 0,
      merged: 0,
      conflicts: 0,
      messages: [],
    };

    let remote: Map<VaultPath, { etag: string; mtime: number; size: number }>;
    try {
      remote = new Map((await this.backend.list()).map((entry) => [normalizePath(entry.path), entry]));
    } catch (error) {
      // Ошибка сети не блокирует работу: всё сохранено локально (BEHAVIOR §6).
      outcome.state = error instanceof SyncError && error.kind === 'unreachable' ? 'offline' : 'error';
      outcome.error =
        outcome.state === 'offline' ? this.strings.errors.offline : (error as Error).message || this.strings.errors.syncFailed;
      outcome.messages.push(outcome.error);
      return outcome;
    }

    const local = new Set<VaultPath>(await this.syncablePaths());
    const paths = new Set<VaultPath>([...local, ...remote.keys(), ...this.queue.list().map((item) => item.path)]);

    // Порядок важен: сначала заметки, потом CRDT-логи. Иначе при слиянии
    // локальный лог уже содержал бы чужие правки, и материализация `.md`
    // затёрла бы их (ТЗ §4.2).
    for (const path of [...paths].sort(byNotesFirst)) {
      if (!this.isSyncable(path)) continue;
      try {
        await this.syncOne(path, local.has(path), remote.get(path), outcome);
      } catch (error) {
        outcome.state = 'error';
        outcome.error = error instanceof SyncError ? error.message : this.strings.errors.syncFailed;
        if (!outcome.messages.includes(outcome.error)) outcome.messages.push(outcome.error);
      }
    }

    this.state.lastSyncAt = this.now();
    await this.saveState();
    const notes = this.vault.notes();
    outcome.noteCount = notes.length;
    outcome.bytes = Object.values(this.state.entries).reduce((sum, entry) => sum + (entry.base?.length ?? 0), 0);
    outcome.lastSyncAt = this.state.lastSyncAt;
    if (outcome.state === 'synced' && this.queue.size > 0) outcome.state = 'syncing';
    return outcome;
  }

  private isSyncable(path: VaultPath): boolean {
    if (!isMetaPath(path)) return true;
    return this.syncCrdt && path.startsWith(`${CRDT_DIR}/`);
  }

  private async syncablePaths(): Promise<VaultPath[]> {
    const notes = await this.vault.notePaths();
    if (!this.syncCrdt) return notes;
    const logs = (await this.storage.list(CRDT_DIR).catch(() => []))
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path);
    return [...notes, ...logs];
  }

  private async syncOne(
    path: VaultPath,
    hasLocal: boolean,
    remoteEntry: { etag: string } | undefined,
    outcome: SyncOutcome,
  ): Promise<void> {
    const state = this.state.entries[path];
    const queued = this.queue.list().find((item) => item.path === path);

    // Удаление: локально файла нет, но он был засинкан или стоит в очереди.
    if (!hasLocal && (queued?.kind === 'delete' || (state && !remoteEntry))) {
      if (remoteEntry) await this.backend.remove(path);
      delete this.state.entries[path];
      await this.queue.done(path);
      return;
    }

    if (!hasLocal && remoteEntry) {
      await this.pull(path, remoteEntry.etag, outcome);
      return;
    }

    const localData = await this.storage.read(path);
    if (localData === null) return;

    if (!remoteEntry) {
      // Файла на той стороне нет — просто выкладываем.
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      outcome.pushed += 1;
      return;
    }

    const localChanged = state === undefined || fnv1a(localData) !== state.baseHash || queued !== undefined;
    const remoteChanged = state === undefined || remoteEntry.etag !== state.etag;

    if (!localChanged && !remoteChanged) {
      await this.queue.done(path);
      return;
    }
    if (localChanged && !remoteChanged) {
      try {
        const { etag } = await this.backend.put(path, localData, state?.etag);
        this.remember(path, etag, localData);
        await this.queue.done(path);
        outcome.pushed += 1;
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
        // Контрагент успел записать между list и put — уходим в слияние.
        await this.merge(path, localData, outcome);
      }
      return;
    }
    if (!localChanged && remoteChanged) {
      await this.pull(path, remoteEntry.etag, outcome);
      return;
    }
    await this.merge(path, localData, outcome);
  }

  private remember(path: VaultPath, etag: string, data: Uint8Array): void {
    const entry: SyncEntryState = {
      etag,
      baseHash: fnv1a(data),
      syncedAt: this.now(),
    };
    // Базу для diff3 держим только для текстовых заметок: бинарь ей не нужен.
    if (!isEncryptedPath(path) && !path.startsWith(`${CRDT_DIR}/`)) entry.base = fromUtf8(data);
    this.state.entries[path] = entry;
  }

  private async pull(path: VaultPath, etag: string, outcome: SyncOutcome): Promise<void> {
    const fetched = await this.backend.get(path);
    if (!fetched) return;
    await writeAtomic(this.storage, path, fetched.data);
    this.remember(path, fetched.etag !== '' ? fetched.etag : etag, fetched.data);
    await this.queue.done(path);
    await this.vault.refresh(path);
    outcome.pulled += 1;
  }

  /** Обе стороны изменились — три пути слияния по ТЗ §4.2. */
  private async merge(path: VaultPath, localData: Uint8Array, outcome: SyncOutcome): Promise<void> {
    const fetched = await this.backend.get(path);
    if (!fetched) {
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      outcome.pushed += 1;
      return;
    }

    // 1. Зашифрованные — автослияние невозможно, сохраняем обе (BEHAVIOR §5.4).
    if (isEncryptedPath(path)) {
      const conflictPath = this.conflictPathFor(path);
      await writeAtomic(this.storage, conflictPath, fetched.data);
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      await this.vault.refresh(conflictPath);
      outcome.conflicts += 1;
      if (!outcome.messages.includes(this.strings.errors.conflictEncrypted)) {
        outcome.messages.push(this.strings.errors.conflictEncrypted);
      }
      return;
    }

    // Служебный CRDT-лог сливается самой библиотекой — просто объединяем.
    if (path.startsWith(`${CRDT_DIR}/`)) {
      const noteId = stemOf(path);
      await this.crdt.append(noteId, fetched.data);
      const merged = (await this.crdt.load(noteId)) ?? localData;
      const { etag } = await this.backend.put(path, merged);
      this.remember(path, etag, merged);
      await this.queue.done(path);
      outcome.merged += 1;
      return;
    }

    const ours = fromUtf8(localData);
    const theirs = fromUtf8(fetched.data);
    const state = this.state.entries[path];
    const base = state?.base ?? '';
    const meta = this.vault.metaOf(path);
    const noteId: NoteId = meta?.id ?? stemOf(path);

    // Гибридный режим: снапшот локальной версии уходит в историю, облачная
    // версия — главная (ТЗ §4.2).
    if (this.mode === 'hybrid') await this.versions.push(noteId, ours, this.deviceName);

    let mergedText: string | null = null;

    // 2. У контрагента есть CRDT-лог — three-way merge через него (ТЗ §4.2).
    const remoteLog = await this.backend.get(`${CRDT_DIR}/${noteId}.bin`);
    if (remoteLog && remoteLog.data.length > 0) {
      // Чужой лог мог отстать от чужого `.md` — если файл правили сторонним
      // редактором, лог об этом не знает. Догоняем чужую сторону её же
      // текстом, иначе слияние молча потеряло бы чужую правку (ТЗ §2.1.4).
      const theirDoc = NoteDoc.fromUpdate(remoteLog.data, `${this.deviceName}/remote`);
      if (theirDoc.toMarkdown() !== theirs) theirDoc.setText(theirs);
      const doc = await this.crdt.loadDoc(noteId, ours);
      doc.applyUpdate(theirDoc.encodeState());
      mergedText = doc.toMarkdown();
      await this.crdt.save(noteId, doc);
      theirDoc.destroy();
      doc.destroy();
    } else {
      // 3. Лога нет (правили чужим редактором) — построчный diff3.
      const result = diff3(base, ours, theirs);
      if (result.ok) mergedText = result.text;
      else {
        // Неразрешимо: обе версии сохранены, чужая уходит в историю (ТЗ §4.2).
        await this.versions.push(noteId, theirs, 'remote');
        mergedText = result.text;
        outcome.conflicts += 1;
      }
    }

    const mergedData = utf8(mergedText);
    await writeAtomic(this.storage, path, mergedData);
    await this.versions.push(noteId, mergedText, this.deviceName, true);
    let etag = fetched.etag;
    try {
      const put = await this.backend.put(path, mergedData, fetched.etag);
      etag = put.etag;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      const put = await this.backend.put(path, mergedData);
      etag = put.etag;
    }
    this.remember(path, etag, mergedData);
    await this.queue.done(path);
    await this.vault.refresh(path);
    outcome.merged += 1;
    // «Версии объединены · История» (BEHAVIOR §6, §11).
    if (!outcome.messages.includes(this.strings.errors.conflictMerged)) {
      outcome.messages.push(this.strings.errors.conflictMerged);
    }
  }

  /** «Дневник (конфликт, устройство Windows)» — BEHAVIOR §5.4. */
  private conflictPathFor(path: VaultPath): VaultPath {
    const dir = dirName(path);
    const extension = path.endsWith('.md.enc') ? '.md.enc' : '.md';
    const name = `${stemOf(path)} ${this.strings.notes.conflictSuffix(this.deviceName)}${extension}`;
    return dir === '' ? name : `${dir}/${name}`;
  }

  /** Материализация CRDT-документа в `.md` и лог — точка входа для редактора. */
  async recordLocalEdit(path: VaultPath, body: string): Promise<void> {
    const meta = this.vault.metaOf(path);
    const noteId: NoteId = meta?.id ?? stemOf(path);
    const doc = await this.crdt.loadDoc(noteId, body);
    doc.setText(body);
    await this.crdt.save(noteId, doc);
    doc.destroy();
    await this.versions.push(noteId, body, this.deviceName);
    await this.markChanged(path);
    if (this.syncCrdt) await this.markChanged(`${CRDT_DIR}/${noteId}.bin`);
  }

  /** Текущий CRDT-документ заметки (для тестов «злого синка» и отладки). */
  async docFor(path: VaultPath, body: string): Promise<NoteDoc> {
    const meta = this.vault.metaOf(path);
    return this.crdt.loadDoc(meta?.id ?? stemOf(path), body);
  }
}
