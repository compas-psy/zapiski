/**
 * Шифрование и разблокировка заметки на уровне файлов (ТЗ §3.3, BEHAVIOR §5.1).
 *
 * Ключевое требование: открытый текст НИКОГДА не пишется на диск. Поэтому
 * порядок такой — сначала атомарно записывается `.md.enc`, только потом
 * исходный `.md` затирается нулями и удаляется, и лишь затем запись убирается
 * из индекса.
 */
import type { CryptoProvider, MasterKey, NoteId, VaultPath, VaultStorage } from '../contract.js';
import { readText, writeAtomic } from '../vault/atomic.js';
import { normalizePath } from '../util/path.js';
import { utf8 } from '../util/bytes.js';
import { LEGACY_CONTAINER_VERSION } from './container.js';
import { VersionHistory } from '../sync/versions.js';
import { CrdtStore } from '../crdt/store.js';

export function encryptedPathOf(path: VaultPath): VaultPath {
  const normalized = normalizePath(path);
  return normalized.endsWith('.md.enc') ? normalized : `${normalized.replace(/\.md$/, '')}.md.enc`;
}

export function plainPathOf(path: VaultPath): VaultPath {
  const normalized = normalizePath(path);
  return normalized.endsWith('.md.enc') ? `${normalized.slice(0, -'.md.enc'.length)}.md` : normalized;
}

/**
 * Зашифровать существующую заметку ключом хранилища. Возвращает путь `.md.enc`.
 * Пароль здесь не спрашивается: он был задан один раз (ТЗ §3.3).
 *
 * `noteId`, если передан, — тот же идентификатор, которым эта заметка
 * адресуется в `.zapiski/versions/<id>.json` и `.zapiski/crdt/<id>.bin`
 * (SyncEngine.recordLocalEdit кладёт их туда при каждом автосохранении). Без
 * очистки эти служебные файлы переживают шифрование как есть — оба хранят
 * ПОЛНЫЙ открытый текст заметки, накопленный до момента шифрования, и второй
 * из них по умолчанию синхронизируется в облако (SEC-003). «Открытый текст
 * никогда не пишется на диск» касается и наследия, оставшегося ДО того, как
 * заметку решили защитить, — иначе обещание держится только для текста,
 * набранного после этого решения.
 */
export async function encryptNoteFile(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  master: MasterKey,
  hint?: string,
  noteId?: NoteId,
): Promise<VaultPath> {
  const source = normalizePath(path);
  const text = await readText(storage, source);
  if (text === null) throw new Error(`Нет такой заметки: ${source}`);
  const key = await provider.deriveNoteKey(master, provider.randomKeyId());
  const container = await provider.encrypt(text, key, hint);
  const target = encryptedPathOf(source);
  await writeAtomic(storage, target, container);
  if (target !== source) {
    // Затирание перед удалением: журналируемые ФС могут оставить блоки
    // доступными, но содержимое по старому пути уже не читается приложением.
    await storage.write(source, new Uint8Array(utf8(text).length)).catch(() => undefined);
    await storage.remove(source);
  }
  if (noteId !== undefined) {
    await new VersionHistory(storage).clear(noteId);
    await new CrdtStore(storage).remove(noteId);
  }
  return target;
}

/**
 * Создать заметку СРАЗУ зашифрованной, минуя `.md` на диске.
 *
 * Отдельная функция, а не «создать и зашифровать»: последовательность из двух
 * шагов положила бы открытый текст на диск и удалила бы его через мгновение.
 * ТЗ §3.3 запрещает это словом «никогда», и «никогда» не имеет исключения для
 * коротких промежутков — между записью и удалением помещается и падение
 * процесса, и снимок файловой системы, и синк.
 */
export async function createEncryptedNote(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  master: MasterKey,
  body: string,
  hint?: string,
): Promise<VaultPath> {
  const target = encryptedPathOf(normalizePath(path));
  const key = await provider.deriveNoteKey(master, provider.randomKeyId());
  await writeAtomic(storage, target, await provider.encrypt(body, key, hint));
  return target;
}

/**
 * Разблокировка: результат живёт только в памяти (ТЗ §3.3).
 *
 * Ключ выбирается по версии контейнера: версии 2 хватает `keyId` из
 * заголовка, версия 1 требует пароль — в ней иерархии нет, и ключ выводился
 * прямо из него.
 */
export async function decryptNoteFile(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  master: MasterKey,
  password?: string,
): Promise<string | null> {
  const data = await storage.read(normalizePath(path));
  if (data === null) return null;
  const header = provider.parseHeader(data);
  if (!header) return null;
  if (header.version === LEGACY_CONTAINER_VERSION) {
    if (password === undefined) return null;
    return provider.decrypt(data, await provider.deriveLegacyKey(password, header.salt));
  }
  if (!header.keyId) return null;
  return provider.decrypt(data, await provider.deriveNoteKey(master, header.keyId));
}

/**
 * Переписать контейнер версии 1 в версию 2 (ленивая миграция).
 *
 * Вызывается после удачной разблокировки: заметка уже расшифрована, платить
 * вторым Argon2id не нужно. Возвращает `false`, если переписывать нечего или
 * запись не удалась, — тогда файл остаётся версии 1 и продолжает открываться
 * тем же паролем.
 */
export async function rewriteToCurrentVersion(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  master: MasterKey,
  body: string,
): Promise<boolean> {
  const target = normalizePath(path);
  const data = await storage.read(target);
  if (data === null) return false;
  const header = provider.parseHeader(data);
  if (!header || header.version !== LEGACY_CONTAINER_VERSION) return false;
  const key = await provider.deriveNoteKey(master, provider.randomKeyId());
  const container = await provider.encrypt(body, key, header.hint);
  try {
    await writeAtomic(storage, target, container);
    return true;
  } catch {
    return false;
  }
}

/**
 * Снятие шифрования (BEHAVIOR §5.3 — одно из трёх мест с диалогом).
 * Возвращает путь `.md` либо null, если пароль не подошёл.
 */
export async function decryptNoteToDisk(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  master: MasterKey,
  password?: string,
): Promise<VaultPath | null> {
  const source = normalizePath(path);
  const text = await decryptNoteFile(storage, provider, source, master, password);
  if (text === null) return null;
  const target = plainPathOf(source);
  await writeAtomic(storage, target, utf8(text));
  if (target !== source) await storage.remove(source);
  return target;
}

/** Подсказка к паролю из контейнера — показывается под полем (BEHAVIOR §5.2). */
export async function passwordHint(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
): Promise<string | null> {
  const data = await storage.read(normalizePath(path));
  if (data === null) return null;
  return provider.parseHeader(data)?.hint ?? null;
}
