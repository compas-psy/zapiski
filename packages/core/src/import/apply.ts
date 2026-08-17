/**
 * Запись импортированного в vault. Единая точка для всех источников —
 * инвариант BEHAVIOR §9 «Импорт никогда не перезаписывает существующие
 * заметки» держится здесь, а не в каждом импортёре.
 */
import type { VaultPath } from '../contract.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { bytesEqual } from '../util/bytes.js';
import { baseName, dirName, joinPath, normalizePath } from '../util/path.js';
import { extractWikiLinks } from '../markdown/parse.js';
import { rewriteWikiLinks } from '../vault/rename.js';
import { uniqueNotePath } from '../vault/naming.js';
import { writeAtomic } from '../vault/atomic.js';
import type { Vault } from '../vault/vault.js';
import { IMPORT_ASSET_LIMIT, type ImportBundle, type ImportReport } from './types.js';

export interface ApplyImportOptions {
  /** Целевая папка мастера импорта (BEHAVIOR §9). */
  targetFolder?: VaultPath;
  locale?: Locale;
  /**
   * Прогресс — мастер показывает его и умеет отменять.
   *
   * `path` нужен экрану хода: спецификация требует показывать текущий путь
   * строкой под полосой (§2, шаг 3), а не проценты. Человек по нему видит, что
   * перенос идёт по его файлам, а не висит.
   */
  onProgress?: (done: number, total: number, path?: string) => void;
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
    /* Ссылки, переписанные импортёром при разборе источника, уже посчитаны:
       путь вложения `assets/…` он привёл к нашей конвенции сам. */
    linksRewritten: bundle.linksRewritten ?? 0,
    suffixed: 0,
    skips: [],
    paths: [],
    warnings: [...bundle.warnings],
    message: '',
  };
  const total = bundle.notes.length + bundle.assets.length;
  let done = 0;
  /** Пути, занятые в рамках текущего импорта: индекс обновляется не мгновенно. */
  const claimed = new Set<VaultPath>();

  /*
   * Сначала РАСКЛАДЫВАЕМ, потом пишем — и это не оптимизация.
   *
   * Коллизия имени даёт суффикс (§4.1), а суффикс делает ложными все
   * `[[wiki-ссылки]]`, которые вели на прежнее имя (§4.3): человек принёс
   * связанные заметки, а получил связи в никуда. Узнать конечные имена можно
   * только пройдя весь список, поэтому первый проход считает пути, второй —
   * пишет уже с переписанными ссылками.
   */
  const planned: Array<{ relative: VaultPath; path: VaultPath; body: string }> = [];
  /** Прежнее имя → новое: только то, что действительно переехало. */
  const renamed = new Map<string, string>();

  for (const note of bundle.notes) {
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
    const finalStem = baseName(path).replace(/\.md$/i, '');
    if (finalStem !== stem) {
      report.suffixed += 1;
      renamed.set(stem, finalStem);
    }
    planned.push({ relative, path, body: note.body });
  }

  if (renamed.size > 0) {
    for (const item of planned) {
      const { body, rewritten } = followRenames(item.body, renamed);
      item.body = body;
      report.linksRewritten += rewritten;
    }
  }

  for (const item of planned) {
    if (options.signal?.aborted) break;
    try {
      await vault.write(item.path, item.body, { created: true, scheduleRename: false });
      report.imported += 1;
      report.paths.push(item.path);
    } catch (error) {
      /* Сбой на одном файле — пропуск и строка в отчёте, конвейер продолжается
         (§4.7). Целиком импорт не падает никогда. */
      report.skipped += 1;
      report.skips.push({ path: item.relative, reason: skipReasonOf(error) });
      report.warnings.push(`${item.relative}: ${(error as Error).message}`);
    }
    done += 1;
    options.onProgress?.(done, total, item.relative);
  }

  for (const asset of bundle.assets) {
    if (options.signal?.aborted) break;
    const path = joinPath(target, normalizePath(asset.relativePath));
    /*
     * Предел одного вложения — 200 МБ (§4.6). Вложение пропускается, заметка
     * переносится: лекция на полтора гигабайта не повод терять текст, к
     * которому она приложена. Файл остаётся у человека на диске, и список
     * пропущенного ведёт именно туда.
     */
    if (asset.data.byteLength > IMPORT_ASSET_LIMIT) {
      report.skipped += 1;
      report.skips.push({ path: asset.relativePath, reason: 'too-large' });
      done += 1;
      options.onProgress?.(done, total, asset.relativePath);
      continue;
    }
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
    options.onProgress?.(done, total, asset.relativePath);
  }

  await vault.persist();
  // Текст отчёта — дословно из реестра BEHAVIOR §11.
  report.message = strings.errors.importPartial(report.imported, report.skipped);
  return report;
}

/**
 * Провести ссылки за переехавшими заметками.
 *
 * Разбор `[[wiki-ссылок]]` не свой: `rewriteWikiLinks` из `vault/rename.ts` уже
 * умеет якоря `#раздел`, подписи `|текст` и совпадение по имени в конце пути —
 * писать это второй раз значило бы завести вторую правду о ссылках. Число
 * подмен считается сравнением целей ДО и ПОСЛЕ, а не повторением правила
 * совпадения: иначе правило пришлось бы держать в двух местах синхронно.
 */
function followRenames(
  body: string,
  renamed: Map<string, string>,
): { body: string; rewritten: number } {
  let out = body;
  let rewritten = 0;
  for (const [from, to] of renamed) {
    const before = extractWikiLinks(out).map((link) => link.target);
    const next = rewriteWikiLinks(out, from, to);
    if (next === null) continue;
    const after = extractWikiLinks(next).map((link) => link.target);
    rewritten += before.filter((target, index) => target !== after[index]).length;
    out = next;
  }
  return { body: out, rewritten };
}

/**
 * Причина пропуска по отказу файловой системы.
 *
 * Набор закрытый (§2): человеку нужен не текст исключения, а одно из четырёх
 * положений дел. Отказ в доступе отличается от повреждённого файла тем, что
 * первый можно исправить, а второй — нет.
 */
function skipReasonOf(error: unknown): 'unreadable' | 'no-access' {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const denied =
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('forbidden') ||
    message.includes('доступ');
  return denied ? 'no-access' : 'unreadable';
}
