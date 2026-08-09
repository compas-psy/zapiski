/**
 * CRDT-документ заметки на Yjs (ADR-0001: Yrs — это Rust-порт Yjs, берём
 * оригинал, протокол обновлений совместим).
 *
 * Текст заметки — `Y.Text`; `.md` на диске — его материализация (ТЗ §4.2).
 * Логические часы Yjs (clientID + clock) означают, что часы устройства на
 * корректность слияния не влияют (ТЗ §4.3).
 */
import * as Y from 'yjs';
import { fnv1a } from '../util/bytes.js';

const TEXT_KEY = 'body';

export interface TextEdit {
  at: number;
  remove: number;
  insert: string;
}

/**
 * Минимальная правка: общий префикс + общий суффикс. Ровно так же поступает
 * связка CodeMirror ↔ Yjs, поэтому слияние параллельных правок ведёт себя
 * предсказуемо: изменённой считается только реально изменённая середина.
 */
export function diffText(previous: string, next: string): TextEdit | null {
  if (previous === next) return null;
  let start = 0;
  const max = Math.min(previous.length, next.length);
  while (start < max && previous[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < max - start &&
    previous[previous.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  return {
    at: start,
    remove: previous.length - start - end,
    insert: next.slice(start, next.length - end),
  };
}

/** Стабильный clientID устройства: имя → число (часы устройства не участвуют). */
export function clientIdFor(deviceName: string): number {
  return fnv1a(deviceName);
}

export class NoteDoc {
  readonly doc: Y.Doc;

  constructor(deviceName = 'local', doc?: Y.Doc) {
    this.doc = doc ?? new Y.Doc();
    this.doc.clientID = clientIdFor(deviceName);
  }

  static fromMarkdown(text: string, deviceName = 'local'): NoteDoc {
    const noteDoc = new NoteDoc(deviceName);
    noteDoc.setText(text);
    return noteDoc;
  }

  static fromUpdate(update: Uint8Array, deviceName = 'local'): NoteDoc {
    const noteDoc = new NoteDoc(deviceName);
    Y.applyUpdate(noteDoc.doc, update);
    // Если в логе уже есть операции этого клиента, оставляем идентификатор,
    // назначенный Yjs: переиспользовать пару (clientID, clock) нельзя — на
    // этом ломается сходимость (ТЗ §4.3, логические часы).
    if (!noteDoc.doc.store.clients.has(clientIdFor(deviceName))) {
      noteDoc.doc.clientID = clientIdFor(deviceName);
    }
    return noteDoc;
  }

  get text(): Y.Text {
    return this.doc.getText(TEXT_KEY);
  }

  toMarkdown(): string {
    return this.text.toString();
  }

  /** Приводит документ к тексту минимальной правкой — не «удалить всё и вставить». */
  setText(next: string): void {
    const current = this.toMarkdown();
    const edit = diffText(current, next);
    if (!edit) return;
    this.doc.transact(() => {
      if (edit.remove > 0) this.text.delete(edit.at, edit.remove);
      if (edit.insert !== '') this.text.insert(edit.at, edit.insert);
    });
  }

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  /** Дельта относительно чужого вектора состояния — это и есть delta-синк. */
  diffUpdate(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update);
  }

  destroy(): void {
    this.doc.destroy();
  }
}

/** Слияние набора обновлений в один компактный лог (ТЗ §4.2). */
export function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  const nonEmpty = updates.filter((update) => update.length > 0);
  if (nonEmpty.length === 0) return new Uint8Array(0);
  if (nonEmpty.length === 1) return nonEmpty[0] as Uint8Array;
  return Y.mergeUpdates(nonEmpty);
}

/**
 * Слияние трёх версий текста через CRDT: общий предок + две ветки.
 * Возвращает текст, к которому сойдутся оба устройства.
 */
export function mergeTexts(base: string, mine: string, theirs: string, deviceName = 'local'): string {
  const baseDoc = NoteDoc.fromMarkdown(base, `${deviceName}/base`);
  const baseState = baseDoc.encodeState();

  const left = NoteDoc.fromUpdate(baseState, `${deviceName}/left`);
  left.setText(mine);
  const right = NoteDoc.fromUpdate(baseState, `${deviceName}/right`);
  right.setText(theirs);

  left.applyUpdate(right.encodeState());
  right.applyUpdate(left.encodeState());
  const result = left.toMarkdown();
  baseDoc.destroy();
  left.destroy();
  right.destroy();
  return result;
}
