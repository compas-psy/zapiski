/**
 * Работа с `VaultPath` (contract.ts): всегда прямые слэши, без ведущего слэша.
 * Единая конвенция на всех платформах — фикс главной боли Obsidian (ТЗ §3.2).
 */
import type { VaultPath } from '../contract.js';

/** Служебный каталог vault'а (ТЗ §3.1). */
export const META_DIR = '.zapiski';
export const TRASH_DIR = `${META_DIR}/trash`;
export const CRDT_DIR = `${META_DIR}/crdt`;
export const VERSIONS_DIR = `${META_DIR}/versions`;
export const INDEX_FILE = `${META_DIR}/index.json`;
export const CONFIG_FILE = `${META_DIR}/config.json`;
export const QUEUE_FILE = `${META_DIR}/sync-queue.json`;
export const ATTACHMENTS_DIR = 'attachments';

export function normalizePath(path: string): VaultPath {
  const unified = path.replace(/\\/g, '/');
  const parts: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function joinPath(...parts: Array<string | undefined>): VaultPath {
  return normalizePath(parts.filter((p): p is string => !!p).join('/'));
}

export function dirName(path: VaultPath): VaultPath {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? '' : normalized.slice(0, idx);
}

export function baseName(path: VaultPath): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function extName(path: VaultPath): string {
  const base = baseName(path);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

/** Имя без расширения `.md` / `.md.enc`. */
export function stemOf(path: VaultPath): string {
  const base = baseName(path);
  if (base.endsWith('.md.enc')) return base.slice(0, -'.md.enc'.length);
  if (base.endsWith('.md')) return base.slice(0, -'.md'.length);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? base : base.slice(0, idx);
}

/**
 * Сравнение путей и расширений — БЕЗ учёта регистра.
 *
 * Windows (NTFS) и macOS (APFS по умолчанию) регистр в именах не различают:
 * `.ZAPISKI/index.json` и `.zapiski/index.json` там один и тот же файл.
 * Регистрозависимая проверка на таких системах пропускала бы служебный путь
 * в дерево заметок — а запись по нему затирала бы настоящий снапшот индекса.
 * Вектор не теоретический: имена приходят из `list()` бэкенда синхронизации,
 * то есть управляются противоположной стороной.
 *
 * По той же причине `.MD` обязан распознаваться как заметка: файл, созданный
 * другим редактором на Windows, иначе просто не появился бы в списке.
 */
function lower(value: string): string {
  return value.toLowerCase();
}

export function isNotePath(path: VaultPath): boolean {
  const p = lower(path);
  return p.endsWith('.md') || p.endsWith('.md.enc');
}

export function isEncryptedPath(path: VaultPath): boolean {
  return lower(path).endsWith('.md.enc');
}

/**
 * Служебные пути (`.zapiski/...`) в дерево заметок не попадают.
 *
 * Проверка намеренно параноидальная: помимо регистра снимаются точки и
 * пробелы в конце каждого сегмента. Windows отбрасывает их при открытии
 * файла, поэтому `.zapiski.` и `.zapiski ` ведут в тот же каталог, а
 * простое сравнение строк их пропускало.
 *
 * Ложное срабатывание здесь безопасно: заметка со странным именем вида
 * `.zapiski.` просто не попадёт в список. Пропуск же означает, что чужие
 * байты запишутся поверх служебных файлов vault'а.
 */
export function isMetaPath(path: VaultPath): boolean {
  const meta = lower(META_DIR);
  const segments = lower(normalizePath(path))
    .split('/')
    .map((segment) => segment.replace(/[. ]+$/, ''));
  return segments[0] === meta;
}

export function isInside(dir: VaultPath, path: VaultPath): boolean {
  const d = normalizePath(dir);
  if (d === '') return true;
  const p = normalizePath(path);
  return p === d || p.startsWith(`${d}/`);
}

/** Относительный путь `from` → `to` (для markdown-ссылок между заметками). */
export function relativePath(fromDir: VaultPath, to: VaultPath): string {
  const from = normalizePath(fromDir).split('/').filter(Boolean);
  const target = normalizePath(to).split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < target.length && from[common] === target[common]) common += 1;
  const up = from.length - common;
  const parts = [...Array<string>(up).fill('..'), ...target.slice(common)];
  return parts.length === 0 ? '.' : parts.join('/');
}

/** Все каталоги-предки пути, от корня к листу (для mkdir -p). */
export function ancestorDirs(path: VaultPath): VaultPath[] {
  const parts = normalizePath(path).split('/').filter(Boolean);
  const out: VaultPath[] = [];
  for (let i = 1; i <= parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}
