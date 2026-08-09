/**
 * Запись импортированного в vault. Единая точка для всех источников —
 * инвариант BEHAVIOR §9 «Импорт никогда не перезаписывает существующие
 * заметки» держится здесь, а не в каждом импортёре.
 */
import type { VaultPath } from '../contract.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { bytesEqual } from '../util/bytes.js';
import { baseName, dirName, joinPath, normalizePath } from '../util/path.js';
import { uniqueNotePath } from '../vault/naming.js';
import { writeAtomic } from '../vault/atomic.js';
import type { Vault } from '../vault/vault.js';
import type { ImportBundle, ImportReport } from './types.js';

export interface ApplyImportOptions {
  /** Целевая папка мастера импорта (BEHAVIOR §9). */
  targetFolder?: VaultPath;
  locale?: Locale;
  /** Прогресс — мастер показывает его и умеет отменять. */
  onProgress?: (done: number, total: number) => void;
  /** Отмена импорта пользователем. */
  signal?: { aborted: boolean };
}

export async function applyImport(
  vault: Vault,
  bundle: ImportBundle,
  options: ApplyImportOptions = {},
): Promise<ImportReport> {
  const strings = catalog(options.locale ?? DEFAULT_LOCALE);
  const target = normalizePath(options.targetFolder ?? '');
  const report: ImportReport = {
    imported: 0,
    skipped: 0,
    attachments: 0,
    paths: [],
    warnings: [...bundle.warnings],
    message: '',
  };
  const total = bundle.notes.length + bundle.assets.length;
  let done = 0;
  /** Пути, занятые в рамках текущего импорта: индекс обновляется не мгновенно. */
  const claimed = new Set<VaultPath>();

  for (const note of bundle.notes) {
    if (options.signal?.aborted) break;
    const relative = normalizePath(note.relativePath);
    const folder = joinPath(target, dirName(relative));
    const stem = baseName(relative).replace(/\.(md|markdown|txt)$/i, '');
    // Коллизия — суффикс ` 2`, ` 3`; существующая заметка не трогается.
    const path = uniqueNotePath(
      folder,
      stem,
      '.md',
      (candidate) => vault.metaOf(candidate) !== undefined || claimed.has(candidate),
    );
    claimed.add(path);
    try {
      await vault.write(path, note.body, { created: true, scheduleRename: false });
      report.imported += 1;
      report.paths.push(path);
    } catch (error) {
      report.skipped += 1;
      report.warnings.push(`${relative}: ${(error as Error).message}`);
    }
    done += 1;
    options.onProgress?.(done, total);
  }

  for (const asset of bundle.assets) {
    if (options.signal?.aborted) break;
    const path = joinPath(target, normalizePath(asset.relativePath));
    const current = await vault.storage.read(path);
    if (current !== null) {
      // Одинаковое вложение переносить незачем, разное — под новым именем.
      if (bytesEqual(current, asset.data)) {
        done += 1;
        options.onProgress?.(done, total);
        continue;
      }
      const dot = path.lastIndexOf('.');
      const stem = dot === -1 ? path : path.slice(0, dot);
      const extension = dot === -1 ? '' : path.slice(dot);
      let n = 2;
      let candidate = `${stem} ${n}${extension}`;
      while ((await vault.storage.read(candidate)) !== null) {
        n += 1;
        candidate = `${stem} ${n}${extension}`;
      }
      await writeAtomic(vault.storage, candidate, asset.data);
    } else {
      await writeAtomic(vault.storage, path, asset.data);
    }
    report.attachments += 1;
    done += 1;
    options.onProgress?.(done, total);
  }

  await vault.persist();
  // Текст отчёта — дословно из реестра BEHAVIOR §11.
  report.message = strings.errors.importPartial(report.imported, report.skipped);
  return report;
}
