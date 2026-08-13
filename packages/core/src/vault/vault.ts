/**
 * Vault — работа с хранилищем поверх порта `VaultStorage` (contract.ts).
 *
 * Инвариант ARCHITECTURE §3.1 «file over app»: источник истины — `.md` на
 * диске, индекс и служебные метаданные восстановимы, удаление `.zapiski/`
 * не теряет ни одной заметки.
 */
import type { Note, NoteId, NoteMeta, UndoableToast, VaultPath, VaultStorage } from '../contract.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { InvertedIndex } from '../index/note-index.js';
import { joinFrontmatter, splitFrontmatter, Frontmatter } from '../markdown/frontmatter.js';
import { parseNote } from '../markdown/parse.js';
import { fnv1a, newId, shortHash } from '../util/bytes.js';
import {
  ATTACHMENTS_DIR,
  baseName,
  dirName,
  INDEX_FILE,
  isEncryptedPath,
  isMetaPath,
  isNotePath,
  joinPath,
  normalizePath,
  stemOf,
  TRASH_DIR,
} from '../util/path.js';
import { escapeRegExp, isoDate } from '../util/text.js';
import { readJson, readText, writeAtomic, writeJsonAtomic, writeTextAtomic } from './atomic.js';
import {
  attachmentFileName,
  safeFileName,
  uniqueNotePath,
  type AttachmentNaming,
} from './naming.js';
import { commitRename, recoverRename, rewriteWikiLinks, wikiTargetFor, type RenameResult } from './rename.js';

/**
 * Идентификатор заметки, когда его нет во frontmatter (ТЗ §3.2: «служебные
 * метаданные — во frontmatter при наличии, иначе в индексе»).
 *
 * Выводится ДЕТЕРМИНИРОВАННО из пути, а не случайно. Это обязательное условие
 * синхронизации: CRDT-логи и история версий лежат в `.zapiski/` по `id`, и без
 * совпадения id на двух устройствах three-way merge через CRDT-лог был бы
 * невозможен (ТЗ §4.2). Плата — id меняется при переименовании файла; для UI
 * это безразлично (обращение идёт по пути), а лог после переименования
 * пересобирается из текста.
 */
export function derivePathId(path: VaultPath): string {
  const normalized = normalizePath(path);
  return `${fnv1a(normalized).toString(36)}${normalized.length.toString(36)}`;
}

/** Задержка переименования файла после правки первой строки (BEHAVIOR §2.2). */
export const RENAME_DELAY_MS = 2000;
/** Срок жизни корзины (ТЗ §5.2). */
export const TRASH_TTL_DAYS = 30;

const TRASH_JOURNAL = `${TRASH_DIR}/index.json`;

/** Служебные метаданные заметки, когда frontmatter'а в файле нет (ТЗ §3.2). */
interface ServiceMeta {
  id: NoteId;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  pinOrder?: number;
}

interface VaultSnapshot {
  version: number;
  index: ReturnType<InvertedIndex['toJSON']>;
  meta: Record<VaultPath, ServiceMeta>;
  mtimes: Record<VaultPath, number>;
}

const SNAPSHOT_VERSION = 1;

export interface TrashEntry {
  id: string;
  /** Где заметка лежала до удаления. */
  originalPath: VaultPath;
  /** Где лежит сейчас. */
  trashPath: VaultPath;
  deletedAt: number;
  title: string;
}

export interface VaultOptions {
  now?: () => number;
  locale?: Locale;
  /** Задержка переименования; в тестах ставится в 0. */
  renameDelayMs?: number;
}

export interface CreateNoteInput {
  title?: string;
  body?: string;
  folder?: VaultPath;
}

/** Куда и под каким именем класть вложение (ITERATION-1 §5). */
export interface AddAttachmentOptions {
  /** Папка. Пусто — общая `attachments/` в корне хранилища. */
  folder?: VaultPath;
  naming?: AttachmentNaming;
  /** Имя, под которым файл пришёл из системы, — для правил `original`. */
  originalName?: string;
}

/** Расширения, при которых вложение вставляется картинкой, а не карточкой. */
const IMAGE_ATTACHMENT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i;

/**
 * Картинка ли это вложение — по расширению.
 *
 * Один и тот же ответ нужен в трёх местах: при вставке (`!` перед ссылкой),
 * при показе в тексте и при тапе (картинку открывает просмотрщик, остальное —
 * системное приложение). Список расширений обязан быть один, иначе файл,
 * вставленный картинкой, откроется как документ.
 */
export function isImageAttachment(path: string): boolean {
  return IMAGE_ATTACHMENT.test(path.split('?')[0]?.split('#')[0] ?? path);
}

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};
const stripExt = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
};

export interface FolderNode {
  path: VaultPath;
  name: string;
  children: FolderNode[];
  /** Количество не-архивных заметок внутри, включая подпапки (BEHAVIOR §3). */
  count: number;
}

export class Vault {
  readonly index = new InvertedIndex();
  private readonly meta = new Map<VaultPath, ServiceMeta>();
  private readonly mtimes = new Map<VaultPath, number>();
  private trashEntries: TrashEntry[] = [];
  private readonly now: () => number;
  private readonly locale: Locale;
  private readonly renameDelayMs: number;
  /** Отложенные переименования: путь → момент, когда пора переименовать. */
  private pendingRenames = new Map<VaultPath, number>();
  private listeners = new Set<(paths: VaultPath[]) => void>();

  constructor(
    readonly storage: VaultStorage,
    options: VaultOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.renameDelayMs = options.renameDelayMs ?? RENAME_DELAY_MS;
  }

  private get strings() {
    return catalog(this.locale);
  }

  static async open(storage: VaultStorage, options: VaultOptions = {}): Promise<Vault> {
    const vault = new Vault(storage, options);
    await vault.open();
    return vault;
  }

  /** Открытие: доигрывание журналов, загрузка снапшота либо полная перестройка. */
  async open(): Promise<void> {
    await recoverRename(this.storage);
    this.trashEntries = (await readJson<TrashEntry[]>(this.storage, TRASH_JOURNAL)) ?? [];
    const snapshot = await readJson<VaultSnapshot>(this.storage, INDEX_FILE);
    if (snapshot && snapshot.version === SNAPSHOT_VERSION && (await this.snapshotIsFresh(snapshot))) {
      this.meta.clear();
      for (const [path, value] of Object.entries(snapshot.meta)) this.meta.set(path, value);
      this.mtimes.clear();
      for (const [path, value] of Object.entries(snapshot.mtimes)) this.mtimes.set(path, value);
      if (this.index.loadSnapshot(snapshot.index)) return;
    }
    await this.rebuild();
  }

  private async snapshotIsFresh(snapshot: VaultSnapshot): Promise<boolean> {
    const paths = await this.notePaths();
    const recorded = Object.keys(snapshot.mtimes);
    if (recorded.length !== paths.length) return false;
    for (const path of paths) {
      const stat = await this.storage.stat(path);
      if (!stat || snapshot.mtimes[path] !== stat.mtime) return false;
    }
    return true;
  }

  /** Полная перестройка индекса из файлов (ТЗ §2.1.1, «Перестроить индекс»). */
  async rebuild(): Promise<void> {
    const notes: Note[] = [];
    this.mtimes.clear();
    for (const path of await this.notePaths()) {
      const note = await this.read(path);
      if (note) notes.push(note);
    }
    this.index.rebuild(notes);
    await this.persist();
  }

  /** Сохранение снапшота индекса и служебных метаданных в `.zapiski/index.json`. */
  async persist(): Promise<void> {
    const snapshot: VaultSnapshot = {
      version: SNAPSHOT_VERSION,
      index: this.index.toJSON(),
      meta: Object.fromEntries(this.meta),
      mtimes: Object.fromEntries(this.mtimes),
    };
    await writeJsonAtomic(this.storage, INDEX_FILE, snapshot);
    await writeJsonAtomic(this.storage, TRASH_JOURNAL, this.trashEntries);
  }

  // ── Обход дерева ───────────────────────────────────────────────────────────

  /** Все пути заметок. Служебный `.zapiski` и корзина исключены. */
  async notePaths(dir: VaultPath = ''): Promise<VaultPath[]> {
    const out: VaultPath[] = [];
    const walk = async (current: VaultPath): Promise<void> => {
      const entries = await this.storage.list(current).catch(() => []);
      for (const entry of entries) {
        if (isMetaPath(entry.path)) continue;
        if (entry.isDirectory) await walk(entry.path);
        else if (isNotePath(entry.path)) out.push(entry.path);
      }
    };
    await walk(normalizePath(dir));
    return out.sort();
  }

  /** Дерево папок для «Библиотеки» (BEHAVIOR §3). */
  async folders(): Promise<FolderNode[]> {
    const notes = this.index.all();
    const roots = new Map<VaultPath, FolderNode>();
    const ensure = (path: VaultPath): FolderNode => {
      const existing = roots.get(path);
      if (existing) return existing;
      const node: FolderNode = { path, name: baseName(path), children: [], count: 0 };
      roots.set(path, node);
      const parent = dirName(path);
      if (parent !== '') ensure(parent).children.push(node);
      return node;
    };
    const seen = new Set<VaultPath>();
    for (const entry of await this.listDirsRecursive('')) {
      if (entry === ATTACHMENTS_DIR || entry.startsWith(`${ATTACHMENTS_DIR}/`)) continue;
      ensure(entry);
      seen.add(entry);
    }
    for (const note of notes) {
      if (note.archived) continue;
      let dir = dirName(note.path);
      while (dir !== '') {
        if (seen.has(dir)) ensure(dir).count += 1;
        dir = dirName(dir);
      }
    }
    return [...roots.values()]
      .filter((node) => dirName(node.path) === '')
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  private async listDirsRecursive(dir: VaultPath): Promise<VaultPath[]> {
    const out: VaultPath[] = [];
    const entries = await this.storage.list(dir).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory || isMetaPath(entry.path)) continue;
      out.push(entry.path);
      out.push(...(await this.listDirsRecursive(entry.path)));
    }
    return out;
  }

  // ── Папки ──────────────────────────────────────────────────────────────────
  //
  // Папка здесь — настоящий каталог на диске, а не выдумка приложения.
  // `folders()` выше читает `listDirsRecursive`, поэтому пустая папка видна в
  // дереве и переживает перезапуск. Это прямо следует из обещания «файл важнее
  // приложения»: человек вправе разложить структуру заранее и увидеть её тем же
  // Проводником.

  /**
   * Создаёт папку. Имя подбирается свободное: две «Практики» рядом сбили бы с
   * толку, а отказ с ошибкой заставил бы придумывать имя дважды.
   */
  async createFolder(parent: VaultPath, name: string): Promise<VaultPath> {
    const base = safeFileName(name);
    const folder = normalizePath(parent);
    let target = joinPath(folder, base);
    for (let n = 2; n < 10_000 && (await this.storage.stat(target)) !== null; n += 1) {
      target = joinPath(folder, `${base} ${n}`);
    }
    await this.storage.mkdir(target);
    this.emit([target]);
    return target;
  }

  /**
   * Переименование папки — это переезд всех заметок внутри неё.
   *
   * Каждая едет через `renameTo`, а не «одним махом» на уровне каталога:
   * только так перепишутся `[[вики-ссылки]]` на переехавшие заметки и
   * пересчитаются идентификаторы CRDT-логов. Цена — цикл по заметкам; выгода —
   * ни одной битой ссылки, что и обещает BEHAVIOR.
   */
  async renameFolder(from: VaultPath, name: string): Promise<{ to: VaultPath; updatedLinks: number }> {
    const source = normalizePath(from);
    return this.relocateFolder(source, dirName(source), safeFileName(name));
  }

  /**
   * Перемещение папки в другого родителя — «Переместить» из меню (BEHAVIOR §3).
   *
   * Отличается от переименования ровно одним: меняется родитель, а не имя. Всё
   * остальное — переезд заметок по одной с переписыванием вики-ссылок — то же
   * самое, поэтому и делается тем же кодом.
   *
   * Папку нельзя положить внутрь себя же: получится отрезанное поддерево,
   * потерянное и для дерева, и для диска. Такая попытка возвращает папку на
   * месте, без изменений.
   */
  async moveFolder(from: VaultPath, parent: VaultPath): Promise<{ to: VaultPath; updatedLinks: number }> {
    const source = normalizePath(from);
    const destination = normalizePath(parent);
    if (destination === source || destination.startsWith(`${source}/`)) {
      return { to: source, updatedLinks: 0 };
    }
    return this.relocateFolder(source, destination, baseName(source));
  }

  /** Общий переезд папки: и переименование, и перемещение — это он. */
  private async relocateFolder(
    source: VaultPath,
    parent: VaultPath,
    base: string,
  ): Promise<{ to: VaultPath; updatedLinks: number }> {
    let target = joinPath(parent, base);
    if (target === source) return { to: source, updatedLinks: 0 };
    for (let n = 2; n < 10_000 && (await this.storage.stat(target)) !== null; n += 1) {
      target = joinPath(parent, `${base} ${n}`);
    }

    await this.storage.mkdir(target);
    let updatedLinks = 0;
    /* Снимок путей до начала: во время цикла индекс меняется под нами. */
    const inside = this.index
      .all()
      .map((note) => note.path)
      .filter((path) => path === source || path.startsWith(`${source}/`));
    for (const path of inside) {
      const result = await this.renameTo(path, joinPath(target, path.slice(source.length + 1)));
      updatedLinks += result.updatedLinks;
    }

    /* Пустые подкаталоги переносим следом, иначе структура схлопнется. */
    for (const dir of await this.listDirsRecursive(source)) {
      await this.storage.mkdir(joinPath(target, dir.slice(source.length + 1)));
    }
    await this.storage.remove(source).catch(() => undefined);
    this.emit([source, target]);
    return { to: target, updatedLinks };
  }

  /**
   * Удаление папки — двумя способами, и выбор делает человек.
   *
   * BEHAVIOR предлагает ровно два исхода: «только папку, заметки в
   * родительскую» и «папку с заметками, в корзину». Это не подтверждение
   * одного действия, а выбор между двумя, поэтому и не диалог подтверждения.
   *
   * Ни в одном из исходов текст не пропадает: в первом заметки переезжают
   * наверх, во втором уезжают в корзину, откуда их можно достать 30 дней.
   * Возвращает затронутые заметки, чтобы экран сказал сколько, а не молчал.
   */
  async deleteFolder(
    path: VaultPath,
    mode: 'notes-to-trash' | 'notes-to-parent' = 'notes-to-trash',
  ): Promise<VaultPath[]> {
    const folder = normalizePath(path);
    /* Снимок до начала: индекс меняется под нами на каждом шаге. */
    const inside = this.index
      .all()
      .map((note) => note.path)
      .filter((item) => item.startsWith(`${folder}/`));

    if (mode === 'notes-to-parent') {
      const parent = dirName(folder);
      for (const note of inside) await this.move(note, parent);
    } else {
      for (const note of inside) await this.trash(note);
    }

    /* Вложенные каталоги убираем снизу вверх, иначе удаление непустого
       каталога отвергается частью хранилищ. */
    const nested = (await this.listDirsRecursive(folder)).sort((a, b) => b.length - a.length);
    for (const dir of nested) await this.storage.remove(dir).catch(() => undefined);
    await this.storage.remove(folder).catch(() => undefined);
    this.emit([folder]);
    return inside;
  }

  // ── Чтение и запись заметок ────────────────────────────────────────────────

  notes(): NoteMeta[] {
    return this.index.all();
  }

  metaOf(path: VaultPath): NoteMeta | undefined {
    return this.index.byPathLookup(path);
  }

  async read(path: VaultPath): Promise<Note | null> {
    const normalized = normalizePath(path);
    const stat = await this.storage.stat(normalized);
    if (!stat) return null;
    this.mtimes.set(normalized, stat.mtime);

    if (isEncryptedPath(normalized)) {
      // Зашифрованная заметка: тело недоступно до разблокировки (ТЗ §3.3).
      const service = this.serviceMeta(normalized, stat.mtime);
      return {
        ...service,
        path: normalized,
        title: stemOf(normalized),
        snippet: '',
        tags: [],
        encrypted: true,
        hasImage: false,
        hasFile: false,
        hasTodo: false,
        hasLink: false,
        wordCount: 0,
        body: '',
      };
    }

    const text = await readText(this.storage, normalized);
    if (text === null) return null;
    return this.noteFromText(normalized, text, stat.mtime);
  }

  private serviceMeta(path: VaultPath, mtime: number): ServiceMeta {
    const existing = this.meta.get(path);
    if (existing) return existing;
    const created: ServiceMeta = {
      id: derivePathId(path),
      createdAt: mtime,
      updatedAt: mtime,
      pinned: false,
      archived: false,
    };
    this.meta.set(path, created);
    return created;
  }

  /** Собирает `Note` из текста файла: frontmatter при наличии, иначе индекс. */
  private noteFromText(path: VaultPath, text: string, mtime: number): Note {
    const parsed = parseNote(text);
    const service = this.serviceMeta(path, mtime);
    const fm = parsed.frontmatter;
    const id = fm?.getString('id') ?? service.id;
    const createdAt = fm?.getNumber('created') ?? fm?.getNumber('createdAt') ?? service.createdAt;
    const updatedAt = fm?.getNumber('updated') ?? fm?.getNumber('updatedAt') ?? service.updatedAt ?? mtime;
    const pinned = fm?.getBoolean('pinned') ?? service.pinned;
    const archived = fm?.getBoolean('archived') ?? service.archived;
    const fmTags = fm ? fm.getList('tags').map((tag) => tag.replace(/^#/, '')) : [];
    const tags = [...new Set([...fmTags, ...parsed.tags])];
    const fromFrontmatter = parsed.title === '' ? fm?.getString('title') : undefined;
    /*
     * Третий источник имени — САМ ФАЙЛ.
     *
     * Заказчик скопировал в папку ЗАПИСОК дерево из Obsidian: «копируются без
     * заголовков самих заметок». Так и было — и это не про копирование. У
     * Obsidian имя заметки это имя файла, а `# Заголовок` в тексте не
     * обязателен; мы же смотрели только в текст и во frontmatter, поэтому весь
     * чужой архив приезжал списком «Без названия».
     *
     * Порядок именно такой: заголовок в тексте — наша договорённость
     * (BEHAVIOR §2.2 держит имя файла в согласии с ним), frontmatter — вторая
     * договорённость, а имя файла — то, что в чужих архивах и есть название.
     * Ниже него остаётся только «Без названия».
     */
    const fromFileName = stemOf(path);
    const title = parsed.title || fromFrontmatter || fromFileName || this.strings.notes.untitled;
    /* «Без названия» приглушённым цветом (ITERATION-1 §1) — только когда имени
       действительно нет НИГДЕ. Файл, который так и называется, тоже считается
       безымянным: это наша же заметка, созданная без заголовка. */
    const untitled =
      parsed.title === '' &&
      !fromFrontmatter &&
      (fromFileName === '' || fromFileName === this.strings.notes.untitled);

    // Идентификатор из frontmatter'а имеет приоритет — так заметка не теряет
    // себя при переносе между устройствами (ТЗ §3.2).
    this.meta.set(path, { ...service, id, createdAt, updatedAt, pinned, archived });

    const note: Note = {
      id,
      path,
      title,
      snippet: parsed.snippet,
      createdAt,
      updatedAt,
      pinned,
      archived,
      tags,
      encrypted: false,
      hasImage: parsed.hasImage,
      hasFile: parsed.hasFile,
      hasTodo: parsed.hasTodo,
      hasLink: parsed.hasLink,
      wordCount: parsed.wordCount,
      body: text,
    };
    if (service.pinOrder !== undefined) note.pinOrder = service.pinOrder;
    if (untitled) note.untitled = true;
    return note;
  }

  /** Создание заметки. Имя файла берётся из заголовка (BEHAVIOR §2.2). */
  async create(input: CreateNoteInput = {}): Promise<Note> {
    const title = input.title ?? '';
    const body = input.body ?? (title === '' ? '' : `# ${title}\n\n`);
    const stem = title !== '' ? title : (parseNote(body).title || this.strings.notes.untitled);
    const path = uniqueNotePath(normalizePath(input.folder ?? ''), stem, '.md', (candidate) => this.exists(candidate));
    return this.write(path, body, { created: true });
  }

  /**
   * Свободный путь под новую заметку — БЕЗ её создания.
   *
   * Нужен ровно одному вызывающему: созданию сразу зашифрованной заметки
   * (ТЗ §3.3). Тот не может воспользоваться `create`, потому что `create`
   * пишет `.md` — то есть открытый текст на диск, — а зашифрованная заметка
   * обязана появиться сразу в `.md.enc`. Занятость проверяется тем же
   * `exists`, что и в `create`, поэтому имена не разъедутся.
   */
  freePath(folder: string, title: string, extension = '.md'): VaultPath {
    const stem = title !== '' ? title : this.strings.notes.untitled;
    return uniqueNotePath(normalizePath(folder), stem, extension, (candidate) => this.exists(candidate));
  }

  private exists(path: VaultPath): boolean {
    return this.index.byPathLookup(path) !== undefined || this.mtimes.has(path);
  }

  /**
   * Запись тела заметки. Автосохранение (BEHAVIOR §0) вызывает именно её:
   * атомарная запись + обновление индекса + постановка переименования в
   * очередь на 2 с (BEHAVIOR §2.2).
   */
  async write(
    path: VaultPath,
    body: string,
    options: { created?: boolean; touch?: boolean; scheduleRename?: boolean } = {},
  ): Promise<Note> {
    const normalized = normalizePath(path);
    const timestamp = this.now();
    const previous = this.meta.get(normalized);
    const service: ServiceMeta = previous ?? {
      id: derivePathId(normalized),
      createdAt: timestamp,
      updatedAt: timestamp,
      pinned: false,
      archived: false,
    };
    service.updatedAt = options.touch === false ? service.updatedAt : timestamp;
    if (options.created) service.createdAt = timestamp;
    this.meta.set(normalized, service);

    const text = this.stampFrontmatter(body, service);
    await writeTextAtomic(this.storage, normalized, text);
    const stat = await this.storage.stat(normalized);
    this.mtimes.set(normalized, stat?.mtime ?? timestamp);

    const note = this.noteFromText(normalized, text, stat?.mtime ?? timestamp);
    this.index.update(note);
    if (options.scheduleRename !== false) this.scheduleRename(normalized);
    this.emit([normalized]);
    return note;
  }

  /**
   * Служебные поля живут во frontmatter, ЕСЛИ он в файле есть, и в индексе,
   * если его нет (ТЗ §3.2). Сам frontmatter мы никогда не создаём: файлы
   * чужого Obsidian-vault'а должны оставаться такими, какими пришли.
   */
  private stampFrontmatter(body: string, service: ServiceMeta): string {
    const split = splitFrontmatter(body);
    if (!split.frontmatter) return body;
    const fm = split.frontmatter as Frontmatter;
    // Чужой id имеет приоритет: заметка не должна терять себя при переносе.
    if (fm.has('id')) service.id = fm.getString('id') ?? service.id;
    else fm.set('id', service.id);
    if (!fm.has('created')) fm.set('created', new Date(service.createdAt).toISOString());
    fm.set('updated', new Date(service.updatedAt).toISOString());
    return joinFrontmatter(fm, split.body);
  }

  // ── Переименование по заголовку ────────────────────────────────────────────

  /** Ставит переименование в очередь: 2 с после прекращения правки (BEHAVIOR §2.2). */
  scheduleRename(path: VaultPath): void {
    this.pendingRenames.set(normalizePath(path), this.now() + this.renameDelayMs);
  }

  /** Выполняет назревшие переименования. Вызывается таймером оболочки и тестами. */
  async flushRenames(force = false): Promise<RenameResult[]> {
    const due: VaultPath[] = [];
    const now = this.now();
    for (const [path, at] of this.pendingRenames) if (force || now >= at) due.push(path);
    const results: RenameResult[] = [];
    for (const path of due) {
      this.pendingRenames.delete(path);
      const result = await this.renameToTitle(path);
      if (result.renamed || result.updatedLinks > 0) results.push(result);
    }
    return results;
  }

  /**
   * Синхронизирует имя файла с заголовком и транзакционно обновляет все
   * wiki-ссылки на заметку (BEHAVIOR §2.2, приёмочный критерий №6).
   */
  async renameToTitle(path: VaultPath): Promise<RenameResult> {
    const normalized = normalizePath(path);
    const note = await this.read(normalized);
    if (!note || note.encrypted) return { from: normalized, to: normalized, renamed: false, updatedLinks: 0 };
    const extension = normalized.endsWith('.md.enc') ? '.md.enc' : '.md';
    const target = uniqueNotePath(
      dirName(normalized),
      note.title,
      extension,
      (candidate) => candidate !== normalized && this.exists(candidate),
      normalized,
    );
    if (target === normalized) return { from: normalized, to: normalized, renamed: false, updatedLinks: 0 };
    return this.renameTo(normalized, target);
  }

  /** Переименование/перемещение в явно указанный путь. */
  async renameTo(from: VaultPath, to: VaultPath): Promise<RenameResult> {
    const source = normalizePath(from);
    const destination = normalizePath(to);
    if (source === destination) return { from: source, to: destination, renamed: false, updatedLinks: 0 };

    const oldTarget = wikiTargetFor(source);
    const newTarget = wikiTargetFor(destination);
    const plan: Array<{ path: VaultPath; body: string }> = [];
    const sourceMeta = this.index.byPathLookup(source);
    const backlinkSources = sourceMeta ? this.index.backlinks(sourceMeta.id) : [];
    for (const backlink of backlinkSources) {
      const text = await readText(this.storage, backlink.path);
      if (text === null) continue;
      const rewritten = rewriteWikiLinks(text, oldTarget, newTarget);
      if (rewritten !== null && rewritten !== text) plan.push({ path: backlink.path, body: rewritten });
    }

    await this.ensureParent(destination);
    const result = await commitRename(this.storage, source, destination, plan, () => newId());

    // Индекс — производная: пересобираем затронутое.
    const service = this.meta.get(source);
    if (service) {
      this.meta.delete(source);
      // id выводится из пути — после переезда он обязан пересчитаться, иначе
      // устройства разойдутся в именах CRDT-логов (см. derivePathId).
      this.meta.set(destination, { ...service, id: derivePathId(destination) });
    }
    this.mtimes.delete(source);
    const previous = this.index.byPathLookup(source);
    if (previous) this.index.remove(previous.id);
    const moved = await this.read(destination);
    if (moved) this.index.update(moved);
    for (const item of plan) {
      const updated = await this.read(item.path);
      if (updated) this.index.update(updated);
    }
    this.emit([source, destination, ...plan.map((item) => item.path)]);
    return result;
  }

  private async ensureParent(path: VaultPath): Promise<void> {
    const dir = dirName(path);
    if (dir !== '') await this.storage.mkdir(dir);
  }

  /** Перемещение заметки в другую папку (drag-and-drop, BEHAVIOR §3). */
  async move(path: VaultPath, folder: VaultPath): Promise<RenameResult> {
    const source = normalizePath(path);
    const destination = uniqueNotePath(
      normalizePath(folder),
      stemOf(source),
      source.endsWith('.md.enc') ? '.md.enc' : '.md',
      (candidate) => this.exists(candidate),
      source,
    );
    return this.renameTo(source, destination);
  }

  // ── Закрепление, архив ─────────────────────────────────────────────────────

  async setPinned(path: VaultPath, pinned: boolean, pinOrder?: number): Promise<NoteMeta | null> {
    return this.patchMeta(path, (service) => {
      service.pinned = pinned;
      if (pinOrder !== undefined) service.pinOrder = pinOrder;
    }, { pinned });
  }

  async setArchived(path: VaultPath, archived: boolean): Promise<NoteMeta | null> {
    return this.patchMeta(path, (service) => {
      service.archived = archived;
    }, { archived });
  }

  /** Архивация — ОО (BEHAVIOR §1.1): тост «Заметка в архиве · Отменить». */
  async archiveWithUndo(path: VaultPath): Promise<UndoableToast> {
    await this.setArchived(path, true);
    return {
      message: this.strings.errors.noteArchived,
      actionLabel: this.strings.actions.undo,
      onAction: async () => {
        await this.setArchived(path, false);
      },
    };
  }

  /**
   * Переименование тега — замена во ВСЕХ заметках, где он встречается.
   *
   * Дерево тегов строится из текстов и напрямую не редактируется: тег живёт в
   * заметке, а не в отдельном списке. Поэтому «переименовать» здесь значит
   * переписать `#старый` на `#новый` в каждой заметке — и отменить это тоже
   * можно только обратной заменой, что и делает ОО-тост (BEHAVIOR §3).
   *
   * Вложенные теги переезжают вместе с родителем: переименовав `практика`,
   * человек ожидает, что `практика/супервизия` тоже станет `работа/супервизия`,
   * а не осиротеет.
   *
   * `null` означает «ни одна заметка не изменилась» — тогда и тоста быть не
   * должно: сообщение «переименовано в 0 заметках» ничего не сообщает.
   */
  async renameTag(
    from: string,
    to: string,
  ): Promise<{ changed: number; undo: UndoableToast } | null> {
    const changed = await this.replaceTag(from, to);
    if (changed === 0) return null;
    return {
      changed,
      undo: {
        message: this.strings.errors.renamedTags(changed),
        actionLabel: this.strings.actions.undo,
        onAction: async () => {
          await this.replaceTag(to, from);
        },
      },
    };
  }

  /** Одна замена по всем заметкам. Возвращает, скольких она коснулась. */
  private async replaceTag(from: string, to: string): Promise<number> {
    const source = from.replace(/^#/, '');
    const target = to.replace(/^#/, '').trim();
    if (source === '' || target === '' || source === target) return 0;

    /* `#практика` и `#практика/супервизия` — да; `#практикант` — нет.
       Граница слева та же, что в разборе тегов, иначе замена заденет
       `##практика` внутри заголовка и адрес в ссылке. Вложенность держится
       на просмотре вперёд: после `практика` идёт `/`, он в границу входит,
       поэтому хвост `/супервизия` остаётся на месте и переезжает с корнем. */
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_/\\\\#])#${escapeRegExp(source)}(?=$|[^\\p{L}\\p{N}_-])`,
      'gu',
    );

    let changed = 0;
    for (const meta of this.index.all()) {
      /* Зашифрованную заметку читать нечем, пока хранилище заперто, а гадать
         по шифротексту нельзя. Тег внутри неё останется старым — это честнее
         молчаливой порчи файла. */
      if (meta.encrypted) continue;
      const note = await this.read(meta.path);
      if (!note) continue;
      const rewritten = note.body.replace(pattern, (_, before: string) => `${before}#${target}`);
      if (rewritten === note.body) continue;
      /* `touch: false` — переименование тега не делает заметку «изменённой
         только что»: иначе список по дате перетасуется весь разом.
         `scheduleRename: false` — заголовок не менялся, файлу переезжать
         некуда. */
      await this.write(meta.path, rewritten, { touch: false, scheduleRename: false });
      changed += 1;
    }
    return changed;
  }

  private async patchMeta(
    path: VaultPath,
    patch: (service: ServiceMeta) => void,
    frontmatterFields: Record<string, boolean>,
  ): Promise<NoteMeta | null> {
    const normalized = normalizePath(path);
    const note = await this.read(normalized);
    if (!note) return null;
    const service = this.serviceMeta(normalized, note.updatedAt);
    patch(service);
    this.meta.set(normalized, service);

    if (!note.encrypted) {
      const split = splitFrontmatter(note.body);
      if (split.frontmatter) {
        for (const [key, value] of Object.entries(frontmatterFields)) split.frontmatter.set(key, value);
        await writeTextAtomic(this.storage, normalized, joinFrontmatter(split.frontmatter, split.body));
      }
    }
    const updated = await this.read(normalized);
    if (updated) this.index.update(updated);
    this.emit([normalized]);
    return updated;
  }

  // ── Корзина (30 дней, ТЗ §5.2) ─────────────────────────────────────────────

  listTrash(): TrashEntry[] {
    return [...this.trashEntries].sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** Удаление — ОО: тост «Заметка в корзине · Отменить» (BEHAVIOR §11). */
  async trash(path: VaultPath): Promise<UndoableToast> {
    const normalized = normalizePath(path);
    const note = await this.read(normalized);
    const id = newId();
    const trashPath = `${TRASH_DIR}/${id}__${baseName(normalized)}`;
    await this.storage.mkdir(TRASH_DIR);
    await this.storage.rename(normalized, trashPath);
    const entry: TrashEntry = {
      id,
      originalPath: normalized,
      trashPath,
      deletedAt: this.now(),
      title: note?.title ?? stemOf(normalized),
    };
    this.trashEntries.push(entry);
    const meta = this.index.byPathLookup(normalized);
    if (meta) this.index.remove(meta.id);
    this.mtimes.delete(normalized);
    await writeJsonAtomic(this.storage, TRASH_JOURNAL, this.trashEntries);
    this.emit([normalized]);
    return {
      message: this.strings.errors.noteTrashed,
      actionLabel: this.strings.actions.undo,
      onAction: async () => {
        await this.restore(id);
      },
    };
  }

  /** Восстановление из корзины. Коллизия имени — суффикс ` 2` (BEHAVIOR §2.2). */
  async restore(entryId: string): Promise<VaultPath | null> {
    const entry = this.trashEntries.find((item) => item.id === entryId);
    if (!entry) return null;
    const extension = entry.originalPath.endsWith('.md.enc') ? '.md.enc' : '.md';
    const destination = uniqueNotePath(
      dirName(entry.originalPath),
      stemOf(entry.originalPath),
      extension,
      (candidate) => this.exists(candidate),
    );
    await this.ensureParent(destination);
    await this.storage.rename(entry.trashPath, destination);
    this.trashEntries = this.trashEntries.filter((item) => item.id !== entryId);
    const restored = await this.read(destination);
    if (restored) this.index.update(restored);
    await writeJsonAtomic(this.storage, TRASH_JOURNAL, this.trashEntries);
    this.emit([destination]);
    return destination;
  }

  /** Чистка корзины: старше 30 дней либо всё (диалог «Очистить корзину»). */
  async purgeTrash(all = false): Promise<number> {
    const deadline = this.now() - TRASH_TTL_DAYS * 86_400_000;
    const doomed = this.trashEntries.filter((entry) => all || entry.deletedAt < deadline);
    for (const entry of doomed) await this.storage.remove(entry.trashPath).catch(() => undefined);
    this.trashEntries = this.trashEntries.filter((entry) => !doomed.includes(entry));
    await writeJsonAtomic(this.storage, TRASH_JOURNAL, this.trashEntries);
    return doomed.length;
  }

  // ── Вложения (ТЗ §3.2) ─────────────────────────────────────────────────────

  /**
   * Копирует файл в `attachments/` под именем `ГГГГ-ММ-ДД_хеш.ext` и возвращает
   * относительный путь — единая конвенция на всех платформах.
   */
  async addAttachment(
    data: Uint8Array,
    extension: string,
    options: AddAttachmentOptions = {},
  ): Promise<{ path: VaultPath; markdown: string }> {
    /* Куда класть — настройка (ITERATION-1 §5). «Рядом с заметкой» означает
       папку самой заметки, а не подпапку в ней: подпапка на каждую заметку
       превращает хранилище в дерево из одного файла в каждом узле. */
    /* `undefined` — правило не задано, значит общая папка. Пустая строка —
       это КОРЕНЬ хранилища, и он законное значение: заметка в корне, у
       которой вложения кладутся «рядом», кладёт их именно туда. Смешать эти
       два случая означало бы, что «рядом с заметкой» для корневой заметки
       молча превращается в `attachments/`. */
    const folder = options.folder === undefined ? ATTACHMENTS_DIR : normalizePath(options.folder);

    const name = attachmentFileName(
      options.naming ?? 'hash',
      isoDate(this.now()),
      shortHash(data),
      options.originalName ?? '',
      extension,
    );
    const path = joinPath(folder, name);
    await this.storage.mkdir(folder);

    /* Файл с таким именем уже лежит. При имени от хеша это тот же файл —
       перезаписывать нечего. При имени от исходного это может быть ЧУЖОЙ файл,
       и затирать его нельзя: подбираем свободное имя. */
    const existing = await this.storage.stat(path);
    const target =
      existing && options.naming && options.naming !== 'hash'
        ? uniqueNotePath(folder, stripExt(name), extOf(name), (candidate) => this.exists(candidate))
        : path;
    if (!existing || target !== path) await writeAtomic(this.storage, target, data);

    const isImage = IMAGE_ATTACHMENT.test(target);
    return { path: target, markdown: `${isImage ? '!' : ''}[](${mdUrl(target)})` };
  }

  /** Вложения, на которые никто не ссылается (Настройки → Хранилище). */
  async orphanAttachments(): Promise<VaultPath[]> {
    const entries = await this.storage.list(ATTACHMENTS_DIR).catch(() => []);
    const used = new Set<string>();
    for (const meta of this.index.all()) {
      const note = await this.read(meta.path);
      if (!note || note.encrypted) continue;
      for (const link of parseNote(note.body).links) used.add(normalizePath(link.url.split('#')[0] as string));
    }
    return entries.filter((entry) => !entry.isDirectory && !used.has(entry.path)).map((entry) => entry.path);
  }

  // ── Уведомления об изменениях ──────────────────────────────────────────────

  onChange(listener: (paths: VaultPath[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(paths: VaultPath[]): void {
    for (const listener of this.listeners) listener(paths);
  }

  /** Сообщить vault'у, что файл изменился извне (синк, чужой редактор). */
  async refresh(path: VaultPath): Promise<Note | null> {
    const normalized = normalizePath(path);
    const note = await this.read(normalized);
    if (note) this.index.update(note);
    else {
      const meta = this.index.byPathLookup(normalized);
      if (meta) this.index.remove(meta.id);
    }
    this.emit([normalized]);
    return note;
  }
}

export { safeFileName, uniqueNotePath };

/**
 * Путь как адрес внутри markdown-ссылки.
 *
 * Пробел в пути разрывает ссылку: `[](Other files/смета.docx)` markdown читает
 * как «ссылка на `Other`» и хвост обычным текстом. Именно это и случилось,
 * когда вложения разложили по папкам `Images`, `Audio` и `Other files`, — на
 * экране вместо карточки файла оставалась строка `(Other files/…docx)`.
 *
 * Канонический выход — угловые скобки: `[](<Other files/смета.docx>)`. Их
 * понимают все реализации CommonMark, и путь внутри остаётся читаемым
 * человеком, в отличие от `%20`.
 */
function mdUrl(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path}>` : path;
}
