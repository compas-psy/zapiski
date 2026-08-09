/**
 * Шифрование и разблокировка заметки на уровне файлов (ТЗ §3.3, BEHAVIOR §5.1).
 *
 * Ключевое требование: открытый текст НИКОГДА не пишется на диск. Поэтому
 * порядок такой — сначала атомарно записывается `.md.enc`, только потом
 * исходный `.md` затирается нулями и удаляется, и лишь затем запись убирается
 * из индекса.
 */
import type { CryptoProvider, VaultPath, VaultStorage } from '../contract.js';
import { readText, writeAtomic } from '../vault/atomic.js';
import { normalizePath } from '../util/path.js';
import { utf8 } from '../util/bytes.js';

export function encryptedPathOf(path: VaultPath): VaultPath {
  const normalized = normalizePath(path);
  return normalized.endsWith('.md.enc') ? normalized : `${normalized.replace(/\.md$/, '')}.md.enc`;
}

export function plainPathOf(path: VaultPath): VaultPath {
  const normalized = normalizePath(path);
  return normalized.endsWith('.md.enc') ? `${normalized.slice(0, -'.md.enc'.length)}.md` : normalized;
}

/**
 * Зашифровать заметку. Возвращает путь `.md.enc`.
 * `key` обязан быть получен из `deriveMasterKey` того же провайдера.
 */
export async function encryptNoteFile(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  key: CryptoKey,
  hint?: string,
): Promise<VaultPath> {
  const source = normalizePath(path);
  const text = await readText(storage, source);
  if (text === null) throw new Error(`Нет такой заметки: ${source}`);
  const container = await provider.encrypt(text, key, hint);
  const target = encryptedPathOf(source);
  await writeAtomic(storage, target, container);
  if (target !== source) {
    // Затирание перед удалением: журналируемые ФС могут оставить блоки
    // доступными, но содержимое по старому пути уже не читается приложением.
    await storage.write(source, new Uint8Array(utf8(text).length)).catch(() => undefined);
    await storage.remove(source);
  }
  return target;
}

/** Разблокировка: результат живёт только в памяти (ТЗ §3.3). */
export async function decryptNoteFile(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  key: CryptoKey,
): Promise<string | null> {
  const data = await storage.read(normalizePath(path));
  if (data === null) return null;
  return provider.decrypt(data, key);
}

/**
 * Снятие шифрования (BEHAVIOR §5.3 — одно из трёх мест с диалогом).
 * Возвращает путь `.md` либо null, если пароль не подошёл.
 */
export async function decryptNoteToDisk(
  storage: VaultStorage,
  provider: CryptoProvider,
  path: VaultPath,
  key: CryptoKey,
): Promise<VaultPath | null> {
  const source = normalizePath(path);
  const text = await decryptNoteFile(storage, provider, source, key);
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
