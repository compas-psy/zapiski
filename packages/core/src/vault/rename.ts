/**
 * Транзакционное переименование (BEHAVIOR §2.2, приёмочный критерий №6):
 * «все wiki-ссылки на неё в vault обновляются автоматически — транзакционно:
 * либо все, либо ни одной».
 *
 * Механика: журнал в `.zapiski/rename.journal.json` + staging-копии старого и
 * нового содержимого в `.zapiski/tmp`. Коммит идёт по журналу; сбой на любом
 * шаге откатывает уже применённые записи из staging-копий. Незакрытый журнал
 * доигрывается при следующем открытии vault'а — падение процесса посреди
 * коммита тоже не оставляет половину ссылок обновлёнными.
 */
import type { VaultPath, VaultStorage } from '../contract.js';
import { extractWikiLinks } from '../markdown/parse.js';
import { normalizeText } from '../util/text.js';
import { META_DIR, stemOf } from '../util/path.js';
import { readJson, readText, writeJsonAtomic, writeTextAtomic } from './atomic.js';

export const RENAME_JOURNAL = `${META_DIR}/rename.journal.json`;

interface JournalStep {
  path: VaultPath;
  /** Куда сохранено новое содержимое. */
  next: VaultPath;
  /** Куда сохранена копия прежнего содержимого — для отката. */
  prev: VaultPath;
}

interface RenameJournal {
  id: string;
  from: VaultPath;
  to: VaultPath;
  steps: JournalStep[];
  /** Индекс шага, до которого коммит доведён. */
  committed: number;
  /** Переименован ли сам файл заметки. */
  fileRenamed: boolean;
}

export interface RenameResult {
  from: VaultPath;
  to: VaultPath;
  renamed: boolean;
  /** Сколько заметок с обновлёнными ссылками (для тоста «Обновлено ссылок: N»). */
  updatedLinks: number;
}

/**
 * Переписывает `[[старое]]` → `[[новое]]` в теле, сохраняя алиасы и якоря.
 * Возвращает null, если ссылок на заметку нет — файл трогать не нужно.
 */
export function rewriteWikiLinks(body: string, oldTarget: string, newTarget: string): string | null {
  const wanted = normalizeText(oldTarget.replace(/\.md$/i, ''));
  const links = extractWikiLinks(body).filter((link) => {
    const target = normalizeText(link.target.replace(/\.md$/i, ''));
    // Совпадение по имени заметки или по полному пути без расширения.
    return target === wanted || target.split('/').pop() === wanted.split('/').pop();
  });
  if (links.length === 0) return null;
  let out = '';
  let cursor = 0;
  for (const link of links) {
    const anchor = link.anchor === undefined ? '' : `#${link.anchor}`;
    const alias = link.alias === undefined ? '' : `|${link.alias}`;
    out += body.slice(cursor, link.start) + `[[${newTarget}${anchor}${alias}]]`;
    cursor = link.end;
  }
  return out + body.slice(cursor);
}

export interface RenamePlanItem {
  path: VaultPath;
  body: string;
}

/**
 * Выполняет транзакцию. `plan` — список файлов с уже подготовленным новым
 * содержимым; `from`/`to` — путь заметки до и после.
 */
export async function commitRename(
  storage: VaultStorage,
  from: VaultPath,
  to: VaultPath,
  plan: RenamePlanItem[],
  makeId: () => string,
): Promise<RenameResult> {
  if (plan.length === 0 && from === to) return { from, to, renamed: false, updatedLinks: 0 };

  const id = makeId();
  const stage = `${META_DIR}/tmp/rename-${id}`;
  const steps: JournalStep[] = [];

  // Фаза 1 — staging. Пока пишем сюда, ни один файл vault'а не тронут.
  for (let i = 0; i < plan.length; i += 1) {
    const item = plan[i] as RenamePlanItem;
    const step: JournalStep = { path: item.path, next: `${stage}/${i}.next`, prev: `${stage}/${i}.prev` };
    const previous = (await readText(storage, item.path)) ?? '';
    await writeTextAtomic(storage, step.prev, previous);
    await writeTextAtomic(storage, step.next, item.body);
    steps.push(step);
  }

  const journal: RenameJournal = { id, from, to, steps, committed: 0, fileRenamed: false };
  await writeJsonAtomic(storage, RENAME_JOURNAL, journal);

  // Фаза 2 — коммит. Любой сбой откатывает всё уже применённое.
  try {
    if (from !== to) {
      await storage.rename(from, to);
      journal.fileRenamed = true;
      await writeJsonAtomic(storage, RENAME_JOURNAL, journal);
    }
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i] as JournalStep;
      const next = await readText(storage, step.next);
      await writeTextAtomic(storage, step.path, next ?? '');
      journal.committed = i + 1;
    }
  } catch (error) {
    await rollback(storage, journal);
    await cleanup(storage, stage);
    throw error;
  }

  await cleanup(storage, stage);
  await storage.remove(RENAME_JOURNAL).catch(() => undefined);
  return { from, to, renamed: from !== to, updatedLinks: plan.length };
}

async function rollback(storage: VaultStorage, journal: RenameJournal): Promise<void> {
  for (let i = journal.committed - 1; i >= 0; i -= 1) {
    const step = journal.steps[i] as JournalStep;
    const previous = await readText(storage, step.prev);
    if (previous !== null) await writeTextAtomic(storage, step.path, previous);
  }
  if (journal.fileRenamed && journal.from !== journal.to) {
    await storage.rename(journal.to, journal.from).catch(() => undefined);
  }
  journal.committed = 0;
  journal.fileRenamed = false;
  await storage.remove(RENAME_JOURNAL).catch(() => undefined);
}

async function cleanup(storage: VaultStorage, stage: VaultPath): Promise<void> {
  await storage.remove(stage).catch(() => undefined);
}

/**
 * Доигрывание журнала при открытии vault'а: если процесс упал посреди коммита,
 * незавершённая транзакция откатывается целиком — инвариант «либо все, либо ни
 * одной» переживает падение приложения.
 */
export async function recoverRename(storage: VaultStorage): Promise<RenameResult | null> {
  const journal = await readJson<RenameJournal>(storage, RENAME_JOURNAL);
  if (!journal || !Array.isArray(journal.steps)) return null;
  await rollback(storage, journal);
  await cleanup(storage, `${META_DIR}/tmp/rename-${journal.id}`);
  return { from: journal.from, to: journal.to, renamed: false, updatedLinks: 0 };
}

/** Цель wiki-ссылки для заметки: имя файла без расширения (стиль Obsidian). */
export function wikiTargetFor(path: VaultPath): string {
  return stemOf(path);
}
