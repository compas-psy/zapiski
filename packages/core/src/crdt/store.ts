/**
 * Компактные CRDT-логи в `.zapiski/crdt/` (ТЗ §3.1, §4.2).
 *
 * Для WebDAV и локальной папки на диске лежат и `.md`, и лог: `.md` —
 * материализация текста, лог — то, что позволяет слить параллельные правки без
 * потерь. Лог всегда хранится СЖАТЫМ в один merged-update: держать журнал
 * операций целиком незачем, история версий живёт отдельно (§4.2).
 */
import type { NoteId, VaultPath, VaultStorage } from '../contract.js';
import { CRDT_DIR } from '../util/path.js';
import { writeAtomic } from '../vault/atomic.js';
import { mergeUpdates, NoteDoc } from './doc.js';

export class CrdtStore {
  constructor(
    private readonly storage: VaultStorage,
    private readonly deviceName = 'local',
  ) {}

  pathFor(noteId: NoteId): VaultPath {
    return `${CRDT_DIR}/${noteId}.bin`;
  }

  async load(noteId: NoteId): Promise<Uint8Array | null> {
    return this.storage.read(this.pathFor(noteId));
  }

  /** Документ заметки: из лога, если он есть, иначе из текста `.md`. */
  async loadDoc(noteId: NoteId, fallbackText: string): Promise<NoteDoc> {
    const update = await this.load(noteId);
    if (update && update.length > 0) {
      const doc = NoteDoc.fromUpdate(update, this.deviceName);
      // `.md` мог быть изменён чужим редактором — подтягиваем его как правку.
      if (doc.toMarkdown() !== fallbackText) doc.setText(fallbackText);
      return doc;
    }
    return NoteDoc.fromMarkdown(fallbackText, this.deviceName);
  }

  async save(noteId: NoteId, doc: NoteDoc): Promise<void> {
    await writeAtomic(this.storage, this.pathFor(noteId), doc.encodeState());
  }

  /** Добавить чужое обновление и сразу компактнуть лог. */
  async append(noteId: NoteId, update: Uint8Array): Promise<void> {
    const existing = await this.load(noteId);
    const merged = mergeUpdates(existing ? [existing, update] : [update]);
    await writeAtomic(this.storage, this.pathFor(noteId), merged);
  }

  async remove(noteId: NoteId): Promise<void> {
    await this.storage.remove(this.pathFor(noteId)).catch(() => undefined);
  }

  async has(noteId: NoteId): Promise<boolean> {
    return (await this.storage.stat(this.pathFor(noteId))) !== null;
  }
}
