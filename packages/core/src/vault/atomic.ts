/**
 * Атомарная запись (ТЗ §4.3): «прерывание синка на любом байте не портит файл».
 *
 * Контракт обязывает `VaultStorage.write` быть атомарной, но полагаться только
 * на дисциплину платформенных оболочек нельзя: запись идёт во временный файл в
 * `.zapiski/tmp` и завершается `rename`, который на всех целевых ФС атомарен.
 */
import type { VaultPath, VaultStorage } from '../contract.js';
import { fnv1a } from '../util/bytes.js';
import { ancestorDirs, dirName, META_DIR } from '../util/path.js';

export const TMP_DIR = `${META_DIR}/tmp`;

let counter = 0;

export function tempPathFor(path: VaultPath): VaultPath {
  counter += 1;
  return `${TMP_DIR}/${fnv1a(path).toString(16)}-${counter.toString(36)}.tmp`;
}

export async function ensureDir(storage: VaultStorage, dir: VaultPath): Promise<void> {
  if (dir === '') return;
  for (const path of ancestorDirs(dir)) await storage.mkdir(path);
}

export async function writeAtomic(storage: VaultStorage, path: VaultPath, data: Uint8Array): Promise<void> {
  await ensureDir(storage, dirName(path));
  await ensureDir(storage, TMP_DIR);
  const temp = tempPathFor(path);
  await storage.write(temp, data);
  try {
    await storage.rename(temp, path);
  } catch (error) {
    // Не оставляем мусор в tmp, если rename не удался.
    await storage.remove(temp).catch(() => undefined);
    throw error;
  }
}

export async function writeTextAtomic(storage: VaultStorage, path: VaultPath, text: string): Promise<void> {
  await writeAtomic(storage, path, new TextEncoder().encode(text));
}

export async function readText(storage: VaultStorage, path: VaultPath): Promise<string | null> {
  const data = await storage.read(path);
  return data === null ? null : new TextDecoder().decode(data);
}

export async function readJson<T>(storage: VaultStorage, path: VaultPath): Promise<T | null> {
  const text = await readText(storage, path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Повреждённый служебный файл — не авария: всё восстановимо из `.md` (ТЗ §2.1.1).
    return null;
  }
}

export async function writeJsonAtomic(storage: VaultStorage, path: VaultPath, value: unknown): Promise<void> {
  await writeTextAtomic(storage, path, JSON.stringify(value));
}
