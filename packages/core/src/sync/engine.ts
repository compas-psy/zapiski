/**
 * Движок синхронизации (ТЗ §4.2, §4.3; BEHAVIOR §6).
 *
 * Свойства, которые здесь обеспечиваются:
 *  • очередь изменений переживает перезапуск (`ChangeQueue`);
 *  • прерывание на любом байте не портит файл (атомарная запись);
 *  • конфликты не теряют данные никогда (ТЗ §2.1.4): сначала CRDT-слияние,
 *    затем diff3, при неразрешимости обе версии сохраняются, чужая уходит
 *    в историю версий;
 *  • в гибридном режиме облачная версия главная, снапшот локальной уходит
 *    в историю;
 *  • зашифрованные `.md.enc` не сливаются никогда — сохраняются обе версии
 *    (BEHAVIOR §5.4).
 */
import type { NoteId, SyncBackend, SyncStatus, VaultPath, VaultStorage } from '../contract.js';
import { CrdtStore } from '../crdt/store.js';
import { NoteDoc } from '../crdt/doc.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { fnv1a, fromUtf8, utf8 } from '../util/bytes.js';
import {
  CRDT_DIR,
  dirName,
  isAttachmentPath,
  isCrdtLogPath,
  isEncryptedPath,
  isMetaPath,
  isNotePath,
  META_DIR,
  normalizePath,
  stemOf,
} from '../util/path.js';
import { readJson, writeAtomic, writeJsonAtomic } from '../vault/atomic.js';
import type { Vault } from '../vault/vault.js';
import { diff3 } from './diff3.js';
import { ChangeQueue } from './queue.js';
import { VersionHistory } from './versions.js';
import { PreconditionFailed } from './local-folder.js';
import { SyncError } from './webdav.js';

const STATE_FILE = `${META_DIR}/sync-state.json`;

/** Побайтовое сравнение: одинаковое содержимое сливать не надо. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Заметки синкаются раньше служебных CRDT-логов. */
function byNotesFirst(a: VaultPath, b: VaultPath): number {
  const left = a.startsWith(`${CRDT_DIR}/`) ? 1 : 0;
  const right = b.startsWith(`${CRDT_DIR}/`) ? 1 : 0;
  return left - right || a.localeCompare(b);
}
/**
 * Версия 2: память разложена по местам синхронизации.
 *
 * В первой версии она была одна на весь vault, и при переходе с папки в
 * облако etag'и папки применялись к облаку. Логика читалась так: «локально не
 * менялось (хеш совпал), у них другой etag — значит забрать чужое», и чужая
 * версия по тому же имени молча ложилась поверх своей. Ровно тот случай,
 * когда человек накопил заметки в папке и подключил облако.
 *
 * Файл первой версии не переносится, а отбрасывается — и это осознанно.
 * Приписать старую память новому месту нельзя (она не про него), а приписать
 * её старому — значит угадывать, какому именно. Пустая память безопасна: без
 * общей истории движок никого не считает устаревшим и идёт в слияние, где обе
 * версии выживают. Для уже сошедшихся сторон слияние ничего не меняет:
 * одинаковые байты распознаются раньше, чем создаётся копия.
 */
const STATE_VERSION = 2;

interface SyncEntryState {
  etag: string;
  /** Текст, на котором стороны сошлись в прошлый раз — база для diff3. */
  base?: string;
  baseHash: number;
  syncedAt: number;
  /**
   * Сколько байт занимает файл. Нужен для честного «в хранилище столько-то»:
   * длина базы этого не скажет — у вложений базы нет вовсе, а у заметки длина
   * строки и число байт расходятся на каждой кириллической букве вдвое.
   */
  size?: number;
}

/** Память об одном месте синхронизации. */
interface RemoteState {
  lastSyncAt: number | null;
  entries: Record<VaultPath, SyncEntryState>;
}

interface SyncStateFile {
  version: number;
  /** Ключ — `id` бэкенда и его `origin`: два WebDAV-сервера не одно и то же. */
  remotes: Record<string, RemoteState>;
}

export type SyncMode = 'hybrid' | 'peer';

export interface SyncEngineOptions {
  deviceName?: string;
  locale?: Locale;
  now?: () => number;
  /** Гибридный режим: облачная версия главная (ТЗ §4.2). */
  mode?: SyncMode;
  /** Синкать ли CRDT-логи — нужно для three-way merge. */
  syncCrdt?: boolean;
  /**
   * Куда сообщать о том, что синк отказался принести (SEC-023). Пользователю
   * это не показывается: чужие файлы в общей папке — норма, а не сбой.
   */
  onIgnored?: (path: VaultPath, reason: string) => void;
  /**
   * Есть ли у устройства сеть. Отвечает оболочка — движок знает только, что
   * не дозвонился.
   *
   * Разница между «нет сети» и «не дозвонился» — не педантизм. Заказчик вошёл
   * через Яндекс ID на телефоне с работающим интернетом и увидел «Оффлайн ·
   * всё сохранено локально»: «фраза фрустрирует — я только что вошёл, но
   * пишет, что оффлайн. Тогда бы понять, что соединение не удалось или что-то
   * ещё». Он прав дважды: слово было неверным, а причина — в другом месте
   * (сервер не пускал запросы приложения), и текст уводил от неё.
   *
   * Умолчание «сеть есть»: движок вызывают там, где сеть предполагается, и
   * честнее сказать «не удалось соединиться», чем объявить оффлайн вслепую.
   */
  isOnline?: () => boolean;
  /**
   * Готовая очередь неотправленного вместо своей.
   *
   * Движок живёт рядом с подключённым местом: нет места — нет движка. А
   * правки человек делает независимо от этого, и очередь обязана переживать
   * не только перезапуск (BEHAVIOR §6), но и отсутствие облака: заказчик
   * просил «работаем локально, пока облако не подключится, а дальше
   * накопленное уходит в синхронизацию».
   *
   * Поэтому владельцем очереди может быть приложение: оно заводит её вместе с
   * хранилищем и передаёт сюда. Переданную очередь движок не перечитывает с
   * диска — она уже загружена, а повторное чтение затёрло бы то, что легло в
   * неё, пока места не было.
   */
  queue?: ChangeQueue;
}

export interface SyncOutcome extends SyncStatus {
  pushed: number;
  pulled: number;
  merged: number;
  conflicts: number;
  /**
   * Сколько заметок убрано здесь по надгробию той стороны — то есть удалено на
   * другом устройстве. Необязательное: у мест без надгробий (папка, WebDAV,
   * Яндекс.Диск) такого понятия нет вовсе, и ноль там значил бы «ничего не
   * удаляли», а не «мы этого не умеем узнать».
   */
  removed?: number;
  /** Тексты для тостов — строго из реестра BEHAVIOR §11. */
  messages: string[];
  /**
   * Пути, которые синк отказался принести в vault (SEC-023). Это не ошибка и
   * не повод для тоста — материал для лога и отладочного меню.
   */
  ignored: VaultPath[];
}

export class SyncEngine {
  readonly queue: ChangeQueue;
  readonly versions: VersionHistory;
  private readonly crdt: CrdtStore;
  private readonly storage: VaultStorage;
  private readonly deviceName: string;
  private readonly locale: Locale;
  private readonly now: () => number;
  private readonly mode: SyncMode;
  private readonly syncCrdt: boolean;
  /** Куда сообщать о пропущенных путях (SEC-023). */
  private readonly onIgnored: ((path: VaultPath, reason: string) => void) | undefined;
  /** Есть ли сеть у устройства — знает оболочка, не движок. */
  private readonly isOnline: () => boolean;
  /** Что пропустили за текущий проход — без повторов. */
  private ignored = new Set<VaultPath>();
  /**
   * Держим удаления: хранилище выглядит опустевшим целиком.
   *
   * Ставится на один проход (см. `runSync`). Пока флаг поднят, движок не
   * удаляет ничего на той стороне — потому что «локально пусто» в такой
   * ситуации значит не «человек всё удалил», а «мы сейчас не видим файлов».
   */
  private holdDeletions = false;
  /** Своя ли очередь: чужую перечитывать с диска нельзя (см. `options.queue`). */
  private readonly ownsQueue: boolean;
  private file: SyncStateFile = { version: STATE_VERSION, remotes: {} };
  /** Память о ТЕКУЩЕМ месте синхронизации. */
  private state: RemoteState = { lastSyncAt: null, entries: {} };
  private loaded = false;
  private running: Promise<SyncOutcome> | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly backend: SyncBackend,
    options: SyncEngineOptions = {},
  ) {
    this.storage = vault.storage;
    this.deviceName = options.deviceName ?? 'local';
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.now = options.now ?? (() => Date.now());
    this.mode = options.mode ?? 'peer';
    this.syncCrdt = options.syncCrdt ?? true;
    this.onIgnored = options.onIgnored;
    this.isOnline = options.isOnline ?? (() => true);
    this.ownsQueue = options.queue === undefined;
    this.queue = options.queue ?? new ChangeQueue(this.storage, this.now);
    this.versions = new VersionHistory(this.storage, this.now);
    this.crdt = new CrdtStore(this.storage, this.deviceName);
  }

  private get strings() {
    return catalog(this.locale);
  }

  /** Кого именно мы помним: место, а не просто вид бэкенда. */
  private get remoteKey(): string {
    return `${this.backend.id}:${this.backend.origin ?? ''}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.ownsQueue) await this.queue.load();
    const file = await readJson<SyncStateFile>(this.storage, STATE_FILE);
    /* Файл прежней версии не переносим: чья это память, из него не следует.
       Пустая память безопаснее угаданной — см. пояснение у STATE_VERSION. */
    if (file && file.version === STATE_VERSION && file.remotes) this.file = file;
    this.state = this.file.remotes[this.remoteKey] ?? { lastSyncAt: null, entries: {} };
    this.loaded = true;
    await this.fillMissingSizes();
  }

  /**
   * Дописать размеры файлам, о которых помним со старой сборки.
   *
   * Размер начали запоминать только сейчас, а память о синхронизации живёт
   * между версиями. Без этого шага человек, обновивший приложение, увидел бы
   * «0 Б» до следующего прохода — то есть снова неправду, просто другую.
   *
   * Спрашиваем только у тех записей, у которых размера нет, и только один раз
   * за запуск: на Android каждый `stat` — обращение к системному провайдеру.
   */
  private async fillMissingSizes(): Promise<void> {
    const missing = Object.entries(this.state.entries).filter(([, entry]) => entry.size === undefined);
    if (missing.length === 0) return;
    for (const [path, entry] of missing) {
      const stat = await this.storage.stat(path).catch(() => null);
      /* Файла нет — размер остаётся неизвестным, а не выдуманным нулём:
         запись всё равно уйдёт при следующем проходе. */
      if (stat) entry.size = stat.size;
    }
  }

  private async saveState(): Promise<void> {
    this.file.remotes[this.remoteKey] = this.state;
    await writeJsonAtomic(this.storage, STATE_FILE, this.file);
  }

  /** Регистрация локального изменения (автосохранение → debounce 5 с, BEHAVIOR §6). */
  async markChanged(path: VaultPath): Promise<void> {
    await this.load();
    await this.queue.enqueue(normalizePath(path), 'put');
  }

  async markDeleted(path: VaultPath): Promise<void> {
    await this.load();
    await this.queue.enqueue(normalizePath(path), 'delete');
  }

  status(): SyncStatus {
    const notes = this.vault.notes();
    return {
      state: this.queue.size > 0 ? 'syncing' : 'synced',
      lastSyncAt: this.state.lastSyncAt,
      noteCount: notes.length,
      bytes: this.knownBytes(),
      pending: this.queue.size,
    };
  }

  /**
   * Сколько байт занимает засинхронизированное — заметки и вложения вместе.
   *
   * Заказчик: «показывает 75 заметок и 79 Б». Число было не объёмом, а
   * количеством записей в памяти синхронизации: `Object.keys(entries).length`
   * с подписью «Б». Второе место считало сумму длин строк — тоже не байты:
   * кириллица в UTF-8 занимает по два байта на букву, а вложения в этой сумме
   * не участвовали вовсе, потому что у них базы нет.
   *
   * Теперь размер каждого файла запоминается при обмене (`remember`), и здесь
   * они просто складываются. Файлы, о которых память осталась от прежней
   * версии формата, размера не имеют — они добавятся к сумме после первого
   * же прохода, а не соврут о нём.
   */
  private knownBytes(): number {
    return Object.values(this.state.entries).reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  }

  /** Один проход синка. Параллельные вызовы разделяют один проход. */
  async sync(): Promise<SyncOutcome> {
    if (this.running) return this.running;
    this.running = this.runSync().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runSync(): Promise<SyncOutcome> {
    await this.load();
    this.ignored = new Set<VaultPath>();
    const outcome: SyncOutcome = {
      state: 'synced',
      lastSyncAt: this.state.lastSyncAt,
      noteCount: 0,
      bytes: 0,
      pending: this.queue.size,
      pushed: 0,
      pulled: 0,
      merged: 0,
      conflicts: 0,
      messages: [],
      ignored: [],
    };

    let remote: Map<VaultPath, { etag: string; mtime: number; size: number }>;
    try {
      remote = new Map((await this.backend.list()).map((entry) => [normalizePath(entry.path), entry]));
    } catch (error) {
      /*
       * Ошибка сети не блокирует работу: всё сохранено локально (BEHAVIOR §6).
       *
       * Но сказать об этом надо ТЕМИ словами, которые соответствуют случаю.
       * «Оффлайн» имеет право звучать, только когда сети действительно нет;
       * если сеть есть, а до облака мы не дозвонились — так и говорим, иначе
       * человек ищет причину не там. Ровно на это и пожаловался заказчик,
       * войдя через Яндекс ID на телефоне с интернетом.
       */
      const unreachable = error instanceof SyncError && error.kind === 'unreachable';
      const offline = unreachable && !this.isOnline();
      outcome.state = unreachable && offline ? 'offline' : 'error';
      outcome.error = offline
        ? this.strings.errors.offline
        : unreachable
          ? this.strings.errors.cloudUnreachable
          : (error as Error).message || this.strings.errors.syncFailed;
      outcome.messages.push(outcome.error);
      return outcome;
    }

    const local = new Set<VaultPath>(await this.syncablePaths());
    const paths = new Set<VaultPath>([...local, ...remote.keys(), ...this.queue.list().map((item) => item.path)]);

    /*
     * Предохранитель: разом опустевшее хранилище — не команда стереть облако.
     *
     * Удаление на той стороне выводится из отсутствия файла здесь: «был в
     * памяти синхронизации, локально нет, у них есть — значит человек его
     * удалил». Для одной заметки это верно. Для всех сразу — почти наверняка
     * нет: так выглядит недоступная папка, отозванное разрешение, ещё не
     * примонтированная карта памяти или открытый не тот корень. Именно этот
     * случай заказчик и описал — «файлы исчезли», — и цена ошибки здесь
     * несимметрична: лишняя копия в облаке стоит мегабайт, а стёртый архив
     * стоит архива.
     *
     * Поэтому: если помним больше двух файлов и локально не осталось НИ
     * ОДНОГО, удаления в этом проходе не выполняются. Забирать чужое сверху
     * (`pull`) при этом никто не мешает — наоборот, так заметки и вернутся.
     */
    const remembered = Object.keys(this.state.entries).length;
    const vanished = remembered > 2 && local.size === 0;
    this.holdDeletions = vanished;
    if (vanished) {
      outcome.messages.push(this.strings.errors.vaultLooksEmpty);
      outcome.error = this.strings.errors.vaultLooksEmpty;
      outcome.state = 'error';
    }

    /*
     * Надгробия той стороны — удаления, сделанные на другом устройстве.
     *
     * До этого удаление ездило только В облако: удалил на телефоне — на
     * Windows заметка осталась, и первая же синхронизация вернула её обратно
     * на телефон. Заказчик описал это как «в нашем облаке практически
     * невозможно удалить ЗАПИСКУ». С шифрованием выходило хуже всего: открытый
     * `.md` приезжал обратно рядом с `.md.enc`, и обещание «всё зашифровано»
     * рассыпалось на глазах.
     *
     * Порядок именно такой — надгробия ПЕРЕД обходом путей: иначе тот же
     * проход сначала скачал бы удалённый файл, а потом мы бы его убрали.
     */
    if (!vanished) await this.applyRemovals(local, remote, outcome);

    // Порядок важен: сначала заметки, потом CRDT-логи. Иначе при слиянии
    // локальный лог уже содержал бы чужие правки, и материализация `.md`
    // затёрла бы их (ТЗ §4.2).
    for (const path of [...paths].sort(byNotesFirst)) {
      if (!this.isSyncable(path)) {
        /*
         * Намерение по пути, который синк не берёт, — это не «ждёт отправки»,
         * а «не отправится никогда». Оставить его в очереди значит навсегда
         * зажечь «есть неотправленное» и никогда не показать «синхронизировано»
         * (`outcome.state` ниже переводится в `syncing` при непустой очереди).
         * Попасть туда легко: в удалённой папке лежал чужой файл, и удаление
         * папки честно заказало удаление всего её содержимого.
         */
        if (this.queue.has(path)) await this.queue.done(path);
        continue;
      }
      try {
        await this.syncOne(path, local.has(path), remote.get(path), outcome);
      } catch (error) {
        outcome.state = 'error';
        outcome.error = error instanceof SyncError ? error.message : this.strings.errors.syncFailed;
        if (!outcome.messages.includes(outcome.error)) outcome.messages.push(outcome.error);
      }
    }

    await this.publishManifest();

    this.state.lastSyncAt = this.now();
    await this.saveState();
    const notes = this.vault.notes();
    outcome.noteCount = notes.length;
    outcome.bytes = this.knownBytes();
    outcome.pending = this.queue.size;
    outcome.lastSyncAt = this.state.lastSyncAt;
    outcome.ignored = [...this.ignored];
    if (outcome.state === 'synced' && this.queue.size > 0) outcome.state = 'syncing';
    return outcome;
  }

  /**
   * Опубликовать оглавление хранилища (SEC-001 §7).
   *
   * Что публикуем — `state.entries`: это и есть память движка о том, что на
   * той стороне лежит. Локальный список тут не годится (в нём есть то, что
   * ещё не уехало), удалённый — тоже (в нём адреса, а не пути).
   *
   * Публикуем ТОЛЬКО когда набор путей изменился: иначе каждый проход синка
   * — а он ходит по таймеру — добавлял бы лишнюю запись на сервер ни за чем.
   * Отметку ставим после успеха, поэтому неудачная публикация повторится
   * следующим проходом, а не потеряется.
   *
   * Порта нет — значит адрес на той стороне и есть путь, и публиковать
   * нечего: у папки, WebDAV и Яндекс.Диска оглавление не имеет смысла.
   */
  private async publishManifest(): Promise<void> {
    if (this.backend.pushManifest === undefined) return;
    const paths = Object.keys(this.state.entries).sort() as VaultPath[];
    const digest = paths.join('\n');
    if (digest === this.publishedManifest) return;
    const ok = await this.backend.pushManifest(paths).catch(() => false);
    if (ok) this.publishedManifest = digest;
  }

  /** Оглавление, которое уже лежит на той стороне, — чтобы не слать его зря. */
  private publishedManifest: string | null = null;

  /**
   * Что синк вообще соглашается положить в vault — БЕЛЫЙ список (SEC-023).
   *
   * Раньше здесь был чёрный: «запрещено служебное, разрешено остальное». Имя
   * файла назначает `list()` бэкенда, то есть сторона, которую модель угроз
   * (THREAT-MODEL §2.2) считает враждебной, а корень vault'а выбирает
   * пользователь — ТЗ §2.1.1 прямо поощряет указать на существующую папку с
   * документами. Указать на домашний каталог никто не мешает, и тогда
   * враждебный сервер писал бы `~/.bashrc` или `~/.config/autostart/*.desktop`
   * — то есть выполнял код при следующем входе в систему.
   *
   * Разрешены ровно три вещи: заметки (`.md`, `.md.enc`), вложения в
   * `attachments/` с известными расширениями и CRDT-логи. Всё остальное
   * пропускается молча для пользователя (чужие файлы в общей папке — норма,
   * а не сбой) и с записью в лог для нас.
   */
  private isSyncable(path: VaultPath): boolean {
    if (isMetaPath(path)) {
      if (this.syncCrdt && isCrdtLogPath(path)) return true;
      this.ignore(path, 'служебный путь vault’а');
      return false;
    }
    if (isNotePath(path) || isAttachmentPath(path)) return true;
    this.ignore(path, 'не заметка, не вложение и не CRDT-лог');
    return false;
  }

  /**
   * Запись о пропущенном пути. Лога как подсистемы в ядре нет, поэтому
   * запись уходит двумя путями: в результат прохода (его видит приложение) и
   * в необязательный обработчик, который платформа может увести в свой лог.
   *
   * Пути здесь — недоверенный ввод, поэтому в лог они попадают обрезанными:
   * длинное имя от противника не должно распирать журнал.
   */
  private ignore(path: VaultPath, reason: string): void {
    const trimmed = path.length > 200 ? `${path.slice(0, 200)}…` : path;
    if (this.ignored.has(trimmed)) return;
    this.ignored.add(trimmed);
    this.onIgnored?.(trimmed, reason);
  }

  /**
   * Что мы вообще предлагаем к обмену.
   *
   * Вложений здесь не было — только заметки и CRDT-логи. То есть картинка,
   * звук и документ никогда не уезжали в облако: на втором устройстве
   * приезжал текст со ссылкой на файл, которого там нет. Заказчик так это и
   * увидел: «картинки не подгружаются и папок Images, Audio и Other files в
   * принципе нет».
   *
   * Обход по файлам, а не по одной известной папке: место вложений человек
   * выбирает сам (§5 настроек), и жёсткий каталог здесь снова разошёлся бы с
   * продуктом. Отбор делает `isAttachmentPath` — белый список расширений.
   */
  private async syncablePaths(): Promise<VaultPath[]> {
    const notes = await this.vault.notePaths();
    const attachments = await this.attachmentPaths('');
    if (!this.syncCrdt) return [...notes, ...attachments];
    const logs = (await this.storage.list(CRDT_DIR).catch(() => []))
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.path);
    return [...notes, ...attachments, ...logs];
  }

  /** Файлы-вложения во всём хранилище, кроме служебного каталога. */
  private async attachmentPaths(dir: VaultPath): Promise<VaultPath[]> {
    const out: VaultPath[] = [];
    for (const entry of await this.storage.list(dir).catch(() => [])) {
      if (isMetaPath(entry.path)) continue;
      if (entry.isDirectory) out.push(...(await this.attachmentPaths(entry.path)));
      else if (isAttachmentPath(entry.path)) out.push(entry.path);
    }
    return out;
  }

  /**
   * Применить удаления, сделанные на другом устройстве.
   *
   * ── Правило разрешения, и почему оно такое ──────────────────────────────────
   *
   * Приходит путь и факт «там его удалили». Здесь возможны три положения дел, и
   * они разные по цене ошибки:
   *
   *  1. **файла у нас нет** — сходиться не о чем, только вычищаем память, чтобы
   *     путь не считался «был засинкан»;
   *  2. **файл есть и не менялся** после последнего обмена — удаляем. Это и есть
   *     то самое «удалил на телефоне — исчезло на Windows»;
   *  3. **файл есть и МЕНЯЛСЯ** здесь — оставляем и отправляем заново.
   *
   * Третий случай — намеренная несимметричность. Удаление на другом устройстве
   * и правка на этом произошли, ничего не зная друг о друге; лишняя заметка
   * стоит одного нажатия, а потерянный текст не стоит ничего вернуть. Поэтому
   * правка побеждает удаление, и человеку об этом говорят словами: молча
   * оставленная заметка выглядела бы как «удаление не работает».
   *
   * Чего здесь НЕТ намеренно: удаления в обход `deleted_at`. Надгробия
   * спрашиваются с момента последнего успешного обмена (`lastSyncAt`), поэтому
   * устройство, пролежавшее в ящике месяц, узнаёт об удалении при первом же
   * включении, а не «пропускает» его.
   */
  private async applyRemovals(
    local: Set<VaultPath>,
    remote: Map<VaultPath, unknown>,
    outcome: SyncOutcome,
  ): Promise<void> {
    if (!this.backend.removals) return;
    /* Первый обмен: спрашивать надгробия не с нуля времени, а не спрашивать
       вовсе. У нас ещё нет памяти о том, что мы вообще синхронизировали, — и
       «удалить всё, что когда-то удаляли там» на новом устройстве означало бы
       стереть файлы, которых мы никогда не видели. */
    const since = this.state.lastSyncAt;
    if (since === null) return;

    let removed: VaultPath[];
    try {
      removed = await this.backend.removals(since);
    } catch {
      /* Надгробия — уточнение, а не основа обмена: не спросили — просто не
         применили в этом проходе. Молчать об этом можно: ни одна правка
         человека от этого не теряется. */
      return;
    }

    for (const raw of removed) {
      const path = normalizePath(raw);
      if (!this.isSyncable(path)) continue;
      /* Путь снова живой на той стороне (удалили и вернули) — надгробие
         устарело, и трогать его нельзя. */
      if (remote.has(path)) continue;

      if (!local.has(path)) {
        delete this.state.entries[path];
        await this.queue.done(path);
        continue;
      }

      const state = this.state.entries[path];
      const data = await this.storage.read(path);
      const changedHere = state === undefined || data === null || fnv1a(data) !== state.baseHash;
      if (changedHere) {
        /* Правка сильнее удаления — оставляем и отправляем заново. */
        await this.queue.enqueue(path, 'put');
        const message = this.strings.errors.deletedElsewhereKept;
        if (!outcome.messages.includes(message)) outcome.messages.push(message);
        continue;
      }

      await this.storage.remove(path).catch(() => undefined);
      local.delete(path);
      delete this.state.entries[path];
      await this.queue.done(path);
      await this.pruneEmptyAncestors(dirName(path));
      outcome.removed = (outcome.removed ?? 0) + 1;
    }
    if ((outcome.removed ?? 0) > 0) await this.vault.rebuild();
  }

  /**
   * Убрать каталоги, опустевшие от только что применённого удаления.
   *
   * ── Зачем ───────────────────────────────────────────────────────────────────
   *
   * Заказчик: «Windows и Web показывают одну картину, а Android другую. В
   * первых 2-х состояние верно». На Android в дереве стояли ЗАПИСКИ в корне и
   * SignalAI внутри СИМПАС/ЗАПИСКИ — обе без счётчика, то есть пустые. На
   * Windows и в вебе их не было.
   *
   * Причина: синхронизация знает файлы и не знает каталогов. Папку перенесли
   * на Windows — там `relocateFolder` убрал каталог сам; на Android приехали
   * только удаления файлов, и пустая оболочка осталась навсегда. Человеку это
   * видно как «телефон показывает папки, которых нет» — и починить её нечем:
   * удалять в приложении нечего, папка пуста и по делу.
   *
   * ── Что здесь можно, а чего нельзя ──────────────────────────────────────────
   *
   * Убираются ТОЛЬКО предки удалённого пути и ТОЛЬКО пока каталог пуст
   * по-настоящему. Значит:
   *
   *  · папка, которую человек завёл заранее и не заполнил, не трогается: файлов
   *    в ней не было, удалений в ней не было, до неё дело не доходит;
   *  · чужой файл в папке (не заметка и не вложение) её сохраняет — мы читаем
   *    каталог целиком, а не только то, что синхронизируем;
   *  · нечитаемый каталог остаётся на месте: «не смогли прочитать» — это не
   *    «пусто», и путать их мы уже один раз научились дорого.
   *
   * Честная цена решения: если на другом устройстве удалили ПОСЛЕДНЮЮ заметку
   * в папке, здесь папка тоже исчезнет, хотя там осталась. Развести эти два
   * случая нельзя — в обмене нет понятия папки вовсе, — а из двух расхождений
   * это заметно меньшее: пустая папка против призрака целого дерева.
   */
  private async pruneEmptyAncestors(dir: VaultPath): Promise<void> {
    let current = normalizePath(dir);
    while (current !== '' && !isMetaPath(current)) {
      const entries = await this.storage.list(current).catch(() => null);
      if (entries === null || entries.length > 0) return;
      await this.storage.remove(current).catch(() => undefined);
      current = dirName(current);
    }
  }

  private async syncOne(
    path: VaultPath,
    hasLocal: boolean,
    remoteEntry: { etag: string } | undefined,
    outcome: SyncOutcome,
  ): Promise<void> {
    const state = this.state.entries[path];
    const queued = this.queue.list().find((item) => item.path === path);

    // Удаление: локально файла нет, но он был засинкан или стоит в очереди.
    if (!hasLocal && (queued?.kind === 'delete' || (state && !remoteEntry))) {
      /* Опустевшее разом хранилище удалений не заказывает — см. `runSync`.
         Память о файле сохраняем: она пригодится, когда папка вернётся. */
      if (this.holdDeletions) return;
      if (remoteEntry) await this.backend.remove(path);
      delete this.state.entries[path];
      await this.queue.done(path);
      return;
    }

    if (!hasLocal && remoteEntry) {
      await this.pull(path, remoteEntry.etag, outcome);
      return;
    }

    const localData = await this.storage.read(path);
    if (localData === null) return;

    if (!remoteEntry) {
      // Файла на той стороне нет — просто выкладываем.
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      outcome.pushed += 1;
      return;
    }

    const localChanged = state === undefined || fnv1a(localData) !== state.baseHash || queued !== undefined;
    const remoteChanged = state === undefined || remoteEntry.etag !== state.etag;

    if (!localChanged && !remoteChanged) {
      await this.queue.done(path);
      return;
    }
    if (localChanged && !remoteChanged) {
      try {
        const { etag } = await this.backend.put(path, localData, state?.etag);
        this.remember(path, etag, localData);
        await this.queue.done(path);
        outcome.pushed += 1;
      } catch (error) {
        if (!(error instanceof PreconditionFailed)) throw error;
        // Контрагент успел записать между list и put — уходим в слияние.
        await this.merge(path, localData, outcome);
      }
      return;
    }
    if (!localChanged && remoteChanged) {
      await this.pull(path, remoteEntry.etag, outcome);
      return;
    }
    await this.merge(path, localData, outcome);
  }

  private remember(path: VaultPath, etag: string, data: Uint8Array): void {
    const entry: SyncEntryState = {
      etag,
      baseHash: fnv1a(data),
      syncedAt: this.now(),
      size: data.byteLength,
    };
    /*
     * Базу для diff3 держим только для ОТКРЫТЫХ ЗАМЕТОК.
     *
     * Условие раньше было «не зашифровано и не CRDT-лог», то есть база
     * заводилась и для вложений: картинка на два мегабайта прогонялась через
     * `fromUtf8` и ложилась строкой в файл состояния синхронизации. Дважды
     * неправильно. Во-первых, состояние распухало на размер всех вложений и
     * перечитывалось при каждом проходе. Во-вторых, при расхождении версий
     * такая «база» шла в трёхстороннее слияние текста — а слить два JPEG
     * построчно нельзя, можно только испортить.
     *
     * Заметка остаётся текстом, и для неё база по-прежнему нужна: без неё
     * одновременная правка с двух устройств давала бы две копии вместо
     * слияния.
     */
    if (isNotePath(path) && !isEncryptedPath(path)) entry.base = fromUtf8(data);
    this.state.entries[path] = entry;
  }

  private async pull(path: VaultPath, etag: string, outcome: SyncOutcome): Promise<void> {
    const fetched = await this.backend.get(path);
    if (!fetched) return;
    await writeAtomic(this.storage, path, fetched.data);
    this.remember(path, fetched.etag !== '' ? fetched.etag : etag, fetched.data);
    await this.queue.done(path);
    await this.vault.refresh(path);
    outcome.pulled += 1;
  }

  /** Обе стороны изменились — три пути слияния по ТЗ §4.2. */
  private async merge(path: VaultPath, localData: Uint8Array, outcome: SyncOutcome): Promise<void> {
    const fetched = await this.backend.get(path);
    if (!fetched) {
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      outcome.pushed += 1;
      return;
    }

    /* Байты совпали — сливать нечего.
       Проверка стоит ДО всех веток слияния и нужна ровно при первом
       соединении с новым местом: общей истории нет, обе стороны считаются
       изменившимися, и без неё одинаковая зашифрованная заметка получила бы
       копию «(конфликт)» на пустом месте. */
    if (sameBytes(localData, fetched.data)) {
      this.remember(path, fetched.etag, localData);
      await this.queue.done(path);
      return;
    }

    // 1. Зашифрованные — автослияние невозможно, сохраняем обе (BEHAVIOR §5.4).
    if (isEncryptedPath(path)) {
      const conflictPath = this.conflictPathFor(path);
      await writeAtomic(this.storage, conflictPath, fetched.data);
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      await this.vault.refresh(conflictPath);
      outcome.conflicts += 1;
      if (!outcome.messages.includes(this.strings.errors.conflictEncrypted)) {
        outcome.messages.push(this.strings.errors.conflictEncrypted);
      }
      return;
    }

    // Служебный CRDT-лог сливается самой библиотекой — просто объединяем.
    if (path.startsWith(`${CRDT_DIR}/`)) {
      const noteId = stemOf(path);
      await this.crdt.append(noteId, fetched.data);
      const merged = (await this.crdt.load(noteId)) ?? localData;
      const { etag } = await this.backend.put(path, merged);
      this.remember(path, etag, merged);
      await this.queue.done(path);
      outcome.merged += 1;
      return;
    }

    const ours = fromUtf8(localData);
    const theirs = fromUtf8(fetched.data);
    const state = this.state.entries[path];
    const base = state?.base ?? '';
    const meta = this.vault.metaOf(path);
    const noteId: NoteId = meta?.id ?? stemOf(path);

    /*
     * Первая встреча с этим местом: общей истории у сторон нет.
     *
     * Так выглядит ровно тот случай, о котором спрашивают в первую очередь:
     * человек накопил заметки в папке и подключил облако, а там по тому же
     * имени лежит другой текст. Сливать нечего — это не две правки одного
     * текста, а два независимых текста, и построчное слияние склеило бы из
     * них третий, которого не писал никто.
     *
     * Поэтому обе версии остаются видимыми: своя — на своём месте, чужая —
     * копией рядом, с названием места в имени. Ровно так же продукт уже
     * поступает с зашифрованными заметками (BEHAVIOR §5.4), и так же ведут
     * себя все синхронизации, которые человек видел до нас.
     */
    if (state === undefined) {
      const conflictPath = this.conflictPathFor(
        path,
        this.strings.notes.conflictPlaceSuffix(this.backend.title),
      );
      await writeAtomic(this.storage, conflictPath, fetched.data);
      const { etag } = await this.backend.put(path, localData);
      this.remember(path, etag, localData);
      await this.queue.done(path);
      await this.vault.refresh(conflictPath);
      outcome.conflicts += 1;
      /* Текст реестра о том, что сохранены обе версии: он описывает именно
         это, а своей формулировки заводить незачем (BEHAVIOR §11). */
      if (!outcome.messages.includes(this.strings.errors.conflictEncrypted)) {
        outcome.messages.push(this.strings.errors.conflictEncrypted);
      }
      return;
    }

    // Гибридный режим: снапшот локальной версии уходит в историю, облачная
    // версия — главная (ТЗ §4.2).
    if (this.mode === 'hybrid') await this.versions.push(noteId, ours, this.deviceName);

    let mergedText: string | null = null;

    // 2. У контрагента есть CRDT-лог — three-way merge через него (ТЗ §4.2).
    const remoteLog = await this.backend.get(`${CRDT_DIR}/${noteId}.bin`);
    if (remoteLog && remoteLog.data.length > 0) {
      // Чужой лог мог отстать от чужого `.md` — если файл правили сторонним
      // редактором, лог об этом не знает. Догоняем чужую сторону её же
      // текстом, иначе слияние молча потеряло бы чужую правку (ТЗ §2.1.4).
      const theirDoc = NoteDoc.fromUpdate(remoteLog.data, `${this.deviceName}/remote`);
      if (theirDoc.toMarkdown() !== theirs) theirDoc.setText(theirs);
      const doc = await this.crdt.loadDoc(noteId, ours);
      doc.applyUpdate(theirDoc.encodeState());
      mergedText = doc.toMarkdown();
      await this.crdt.save(noteId, doc);
      theirDoc.destroy();
      doc.destroy();
    } else {
      // 3. Лога нет (правили чужим редактором) — построчный diff3.
      const result = diff3(base, ours, theirs);
      if (result.ok) mergedText = result.text;
      else {
        // Неразрешимо: обе версии сохранены, чужая уходит в историю (ТЗ §4.2).
        await this.versions.push(noteId, theirs, 'remote');
        mergedText = result.text;
        outcome.conflicts += 1;
      }
    }

    const mergedData = utf8(mergedText);
    await writeAtomic(this.storage, path, mergedData);
    await this.versions.push(noteId, mergedText, this.deviceName, true);
    let etag = fetched.etag;
    try {
      const put = await this.backend.put(path, mergedData, fetched.etag);
      etag = put.etag;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      const put = await this.backend.put(path, mergedData);
      etag = put.etag;
    }
    this.remember(path, etag, mergedData);
    await this.queue.done(path);
    await this.vault.refresh(path);
    outcome.merged += 1;
    // «Версии объединены · История» (BEHAVIOR §6, §11).
    if (!outcome.messages.includes(this.strings.errors.conflictMerged)) {
      outcome.messages.push(this.strings.errors.conflictMerged);
    }
  }

  /** «Дневник (конфликт, устройство Windows)» — BEHAVIOR §5.4. */
  private conflictPathFor(path: VaultPath, suffix?: string): VaultPath {
    const dir = dirName(path);
    const extension = path.endsWith('.md.enc') ? '.md.enc' : '.md';
    const mark = suffix ?? this.strings.notes.conflictSuffix(this.deviceName);
    const name = `${stemOf(path)} ${mark}${extension}`;
    return dir === '' ? name : `${dir}/${name}`;
  }

  /** Материализация CRDT-документа в `.md` и лог — точка входа для редактора. */
  async recordLocalEdit(path: VaultPath, body: string): Promise<void> {
    const meta = this.vault.metaOf(path);
    const noteId: NoteId = meta?.id ?? stemOf(path);
    const doc = await this.crdt.loadDoc(noteId, body);
    doc.setText(body);
    await this.crdt.save(noteId, doc);
    doc.destroy();
    await this.versions.push(noteId, body, this.deviceName);
    await this.markChanged(path);
    if (this.syncCrdt) await this.markChanged(`${CRDT_DIR}/${noteId}.bin`);
  }

  /** Текущий CRDT-документ заметки (для тестов «злого синка» и отладки). */
  async docFor(path: VaultPath, body: string): Promise<NoteDoc> {
    const meta = this.vault.metaOf(path);
    return this.crdt.loadDoc(meta?.id ?? stemOf(path), body);
  }
}
