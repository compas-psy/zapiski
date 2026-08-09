/**
 * История версий: локально последние 50 снапшотов на заметку (ТЗ §4.2).
 * Лежит в `.zapiski/versions/<noteId>.json` — служебное, восстановимое,
 * удаление `.zapiski/` не трогает сами заметки.
 */
import type { NoteId, VaultPath, VaultStorage, VersionSnapshot } from '../contract.js';
import { newId } from '../util/bytes.js';
import { VERSIONS_DIR } from '../util/path.js';
import { readJson, writeJsonAtomic } from '../vault/atomic.js';

export const MAX_SNAPSHOTS = 50;

export class VersionHistory {
  constructor(
    private readonly storage: VaultStorage,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private pathFor(noteId: NoteId): VaultPath {
    return `${VERSIONS_DIR}/${noteId}.json`;
  }

  async list(noteId: NoteId): Promise<VersionSnapshot[]> {
    const snapshots = (await readJson<VersionSnapshot[]>(this.storage, this.pathFor(noteId))) ?? [];
    return snapshots.sort((a, b) => b.takenAt - a.takenAt);
  }

  /** Кладёт снапшот, вытесняя самые старые сверх 50. */
  async push(noteId: NoteId, body: string, source: string, merged = false): Promise<VersionSnapshot> {
    const snapshots = await this.list(noteId);
    const snapshot: VersionSnapshot = { id: newId(), noteId, takenAt: this.now(), source, merged, body };
    // Дубликат подряд не пишем: автосохранение раз в 500 мс иначе забьёт историю.
    const latest = snapshots[0];
    if (latest && latest.body === body) return latest;
    const next = [snapshot, ...snapshots].slice(0, MAX_SNAPSHOTS);
    await writeJsonAtomic(this.storage, this.pathFor(noteId), next);
    return snapshot;
  }

  async get(noteId: NoteId, versionId: string): Promise<VersionSnapshot | null> {
    return (await this.list(noteId)).find((snapshot) => snapshot.id === versionId) ?? null;
  }

  async clear(noteId: NoteId): Promise<void> {
    // Шифрование удаляет локальные версии за период до него (BEHAVIOR §5.1).
    await this.storage.remove(this.pathFor(noteId)).catch(() => undefined);
  }
}
