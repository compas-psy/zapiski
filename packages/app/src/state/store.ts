/**
 * Состояние приложения и все действия над ним.
 *
 * Здесь нет ни одной платформенной детали: всё, что нужно от устройства,
 * приходит через `AppHost` (contract.ts). Поэтому один и тот же контроллер
 * работает в вебе, на Windows и на Android (ARCHITECTURE §1).
 */
import {
  ChangeQueue,
  LEGACY_CONTAINER_VERSION,
  MemoryVaultStorage,
  META_DIR,
  SyncEngine,
  Vault,
  VersionHistory,
  WebCryptoProvider,
  YandexDiskBackend,
  catalog as coreCatalog,
  countWords,
  createEncryptedNote,
  decryptNoteFile,
  decryptNoteToDisk,
  encryptNoteFile,
  encryptedPathOf,
  exportArchive,
  exportNote,
  exportPdf,
  fromBase64,
  isEncryptedPath,
  parseQuery,
  passwordHint,
  readJson,
  rewriteToCurrentVersion,
  ATTACHMENTS_DIR,
  attachmentDirFor,
  isAttachmentDir,
  stemOf,
  storedLocale,
  toBase64,
  UnlockGuard,
  writeAtomic,
  writeJsonAtomic,
  type FolderNode,
  type AddAttachmentOptions,
  type AttachmentEntry,
  type AttachmentNaming,
  type MasterKey,
  type Note,
  type NoteMeta,
  type SearchHit,
  type SyncBackend,
  type SyncStatus,
  type TrashEntry,
  type Catalog,
  type UndoableToast,
  type UnlockGuardRecord,
  type VaultLocation,
  type VaultLocationInfo,
  type VaultPath,
  type VaultStorage,
  type VersionSnapshot,
} from '@zapiski/core';
import type {
  AttachmentPlacement,
  AppHost,
  AuthCallback,
  DebugOverrides,
  Route,
  ScreenState,
  SettingsSection,
} from '../contract.js';
import { strings as buildStrings, DEFAULT_LOCALE, type Locale, type Strings } from '../i18n/index.js';
import { attachmentMime } from '../lib/attachment-urls.js';
import { cropImage, type CropRect } from '../lib/crop.js';
import { downscaleImage } from '../lib/downscale.js';
import { createCloudBackend } from './cloud.js';
import { AuthError, SessionStore, type AuthErrorCode, type Consents } from './session.js';

/** Сортировка списка. Запоминается НА ПАПКУ, не глобально (BEHAVIOR §1.2). */
export type SortMode = 'updated' | 'created' | 'title' | 'manual';

/** Что именно показывает список: все / закреплённые / архив / корзина. */
export type ListScope = 'all' | 'pinned' | 'archive' | 'trash';

/** Экраны матрицы BEHAVIOR §12 — ключи для отладочного меню. */
export type MatrixScreen =
  | 'list'
  | 'folder'
  | 'note'
  | 'search'
  | 'library'
  | 'archive'
  | 'trash'
  | 'settingsSync'
  | 'backlinks';

/**
 * Матрица «экран × состояние» из BEHAVIOR §12 дословно: `true` — ячейка
 * заполнена в таблице, `false` — прочерк. Отладочное меню показывает ровно
 * заполненные ячейки (приёмочный критерий №10).
 */
export const MATRIX: Record<MatrixScreen, Record<Exclude<ScreenState, 'normal'>, boolean>> = {
  list: { empty: true, loading: true, offline: true, error: true, locked: true },
  folder: { empty: true, loading: true, offline: true, error: true, locked: false },
  note: { empty: true, loading: true, offline: true, error: true, locked: true },
  search: { empty: true, loading: false, offline: true, error: false, locked: true },
  library: { empty: true, loading: true, offline: false, error: false, locked: false },
  archive: { empty: true, loading: true, offline: false, error: false, locked: false },
  trash: { empty: true, loading: true, offline: false, error: false, locked: false },
  settingsSync: { empty: false, loading: true, offline: true, error: true, locked: false },
  backlinks: { empty: true, loading: false, offline: false, error: false, locked: false },
};

export interface AccountState {
  email: string | null;
  plan: 'free' | 'plus';
  /**
   * Добровольное согласие на рекламные письма. Живёт рядом с аккаунтом,
   * потому что и отзывается там же — в настройках, а не в переписке с нами.
   */
  marketingOptIn?: boolean;
}

/** Расшифрованная заметка живёт ТОЛЬКО в памяти (ТЗ §3.3, BEHAVIOR §5.3). */
interface UnlockedNote {
  body: string;
  key: CryptoKey;
  unlockedAt: number;
  /** Момент автозамка. */
  lockAt: number;
}

export interface AppState {
  /** vault открыт и список готов. */
  ready: boolean;
  /** идёт первичная загрузка — показываем скелетоны, не спиннер (SCREENS §3). */
  booting: boolean;
  locale: Locale;
  route: Route;
  /** Стек для «назад» — mobile push-переходы. */
  stack: Route[];

  notes: NoteMeta[];
  folders: FolderNode[];
  tags: Array<{ tag: string; count: number }>;
  trash: TrashEntry[];
  /**
   * Файлы открытой папки вложений — `Images`, `Audio`, `Other files`.
   *
   * Заказчик: «файлы по факту в папках есть, но они не отображаются
   * приложением». Так и было: список показывает заметки, а в этих папках лежат
   * файлы, поэтому открытая папка выглядела пустой при полной папке на диске.
   * Пусто, когда открыта не папка вложений.
   */
  folderFiles: AttachmentEntry[];

  scope: ListScope;
  folder: string | null;
  tag: string | null;
  /** Сортировка на папку: ключ — путь папки (пустая строка = корень). */
  sortByFolder: Record<string, SortMode>;

  query: string;
  results: SearchHit[];
  recentQueries: string[];
  lastOpened: VaultPath[];

  sync: SyncStatus;
  backendId: SyncBackend['id'] | null;
  /**
   * Что человек ВЫБРАЛ, а не что удалось подключить.
   *
   * Заказчик: «вчера подключил облако — всё синхронизировал; сегодня открыл, и
   * оно само переключилось на локальную папку». Переключения не было: выбор
   * так и лежал в настройках устройства, но подключить облако не вышло
   * (сессия не восстановилась), а экран показывал только подключённое — то
   * есть «Только на этом устройстве». Со стороны это неотличимо от того, что
   * приложение само поменяло решение человека.
   *
   * Поэтому выбор и подключение разведены: выбранным показывается выбранное,
   * а рядом честно говорится, что подключиться не удалось и почему.
   */
  backendChoice: SyncBackend['id'] | null;
  /**
   * Облако выбрано, но вход не действует: нужен повторный вход.
   *
   * Отдельный признак, а не ошибка синхронизации: чинится он не «повторить»,
   * а «войти», и человеку надо сказать именно это.
   */
  cloudNeedsSignIn: boolean;
  online: boolean;

  /**
   * Раскрытые узлы дерева папок.
   *
   * Живёт здесь, а не внутри `Tree`, из-за телефона: там библиотека — ящик, и
   * выбор папки его закрывает. `Drawer` при закрытии размонтируется полностью,
   * вместе с внутренним состоянием дерева, — значит раскрытая папка сворачивалась
   * обратно, и подпапка не появлялась никогда, сколько по ней ни тапай.
   */
  expandedFolders: string[];

  libraryOpen: boolean;
  paletteOpen: boolean;
  infoOpen: boolean;
  focusMode: boolean;
  rawMode: boolean;
  debugOpen: boolean;
  shareOpen: boolean;
  /**
   * Онбординг только что закончился и открыта ПЕРВАЯ заметка: над текстом
   * висит чип «Локальный режим включён — можно писать» (SCREENS §1, шаг 3).
   * Отдельного экрана «успех» нет — есть этот чип и курсор в заголовке.
   */
  firstRun: boolean;

  account: AccountState | null;

  /**
   * Где лежат заметки и что это место умеет (ТЗ §4.3). `null` — платформа
   * различий не делает: выбранная папка ничем не хуже умолчания.
   */
  vaultLocation: VaultLocationInfo | null;

  /** Пути с открытым (расшифрованным) содержимым. */
  unlocked: Record<VaultPath, UnlockedNote>;
  /**
   * Неудачные попытки пароля — задержки BEHAVIOR §5.2.
   *
   * Зеркало счётчика из `UnlockGuard` для экранов. Сам счётчик живёт в
   * настройках приложения и переживает перезапуск (SEC-024).
   */
  failedAttempts: number;
  /** До какого момента ввод пароля отклоняется. Данные не удаляются никогда. */
  lockedUntil: number;

  debug: DebugOverrides;

  /**
   * Последняя ошибка для статуса синка. НИКОГДА не превращается в модалку и
   * не блокирует ввод (BEHAVIOR §0, приёмочный критерий №5).
   */
  syncError: string | null;

  /**
   * Отказ входа — текст из реестра BEHAVIOR §11. Живёт на экране входа и
   * ничего не блокирует: без аккаунта приложение работает полностью
   * (ТЗ §5.5 — аккаунт нужен ТОЛЬКО для облака).
   */
  authError: string | null;
  /** Идёт обмен токена после возврата по ссылке. */
  authBusy: boolean;
}

export type Listener = () => void;

function initialState(locale: Locale): AppState {
  return {
    ready: false,
    booting: true,
    locale,
    route: { name: 'list' },
    stack: [],
    notes: [],
    folders: [],
    tags: [],
    trash: [],
    folderFiles: [],
    scope: 'all',
    folder: null,
    tag: null,
    sortByFolder: {},
    query: '',
    results: [],
    recentQueries: [],
    lastOpened: [],
    sync: { state: 'offline', lastSyncAt: null, noteCount: 0, bytes: 0 },
    backendId: null,
    backendChoice: null,
    cloudNeedsSignIn: false,
    online: true,
    expandedFolders: [],
    libraryOpen: false,
    paletteOpen: false,
    infoOpen: false,
    focusMode: false,
    rawMode: false,
    debugOpen: false,
    shareOpen: false,
    firstRun: false,
    account: null,
    vaultLocation: null,
    unlocked: {},
    failedAttempts: 0,
    lockedUntil: 0,
    debug: { forceState: null, forceSyncBackend: null },
    syncError: null,
    authError: null,
    authBusy: false,
  };
}

export interface ToastRequest {
  message: string;
  actionLabel?: string | undefined;
  onAction?: (() => void | Promise<void>) | undefined;
}

/** MIME-типы экспорта — платформа отдаёт файл пользователю (BEHAVIOR §9). */
const MIME: Record<'md' | 'html' | 'docx', string> = {
  md: 'text/markdown',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Ключи в `PreferencesStore` (настройки вне vault'а). */
const PREF = {
  locale: 'locale',
  attachmentPlacement: 'attachments.placement',
  attachmentNaming: 'attachments.naming',
  attachmentFolder: 'attachments.folder',
  attachmentDownscale: 'attachments.downscale',
  /** Показывать ли служебные папки вложений в дереве библиотеки. */
  attachmentFoldersShown: 'attachments.showFolders',
  /** Показывать ли в папке заметки из вложенных папок. */
  subfolderNotes: 'list.subfolderNotes',
  sort: 'list.sort',
  recent: 'search.recent',
  lastOpened: 'search.lastOpened',
  backend: 'sync.backend',
  autoLock: 'security.autoLockMinutes',
  /**
   * Счётчик неудачных попыток пароля и конец задержки (BEHAVIOR §5.2,
   * SEC-024). Лежит рядом с остальными настройками — то есть ВНЕ vault'а:
   * vault бывает на съёмном носителе или в чужой синкаемой папке, а задержка
   * обязана действовать и тогда, когда его нет. Секрета в записи нет: три
   * числа, по которым о содержимом заметок узнать нечего.
   */
  unlockGuard: 'security.unlockGuard',
  account: 'account',
  /** Токен доступа к Яндекс.Диску — он от Диска, а не от входа в аккаунт. */
  yandexToken: 'sync.yandexToken',
  /** «Шифровать новые заметки» — раздел «Безопасность» (ТЗ §3.3). */
  encryptNewNotes: 'security.encryptNewNotes',
  /** Включена ли биометрия для хранилища. Сам ключ живёт в keystore. */
  biometrics: 'security.biometrics',
  onboarded: 'onboarded',
} as const;

/**
 * Где лежит соль хранилища и под каким именем ключ в платформенном хранилище.
 *
 * Соль — служебная и восстановимая: она есть в заголовке каждого контейнера,
 * а этот файл лишь избавляет от их перебора. Поэтому он в `.zapiski/`, вместе
 * с остальным, что можно потерять без последствий. Ключа хранилища на диске
 * нет нигде и быть не должно: всё нужное для расшифровки — в самом контейнере
 * плюс пароль в голове у человека («Ключ только у вас», §1.5 дизайна).
 */
const VAULT_KEY_PATH = `${META_DIR}/crypto.json`;
const VAULT_KEY_ID = 'vault';

/**
 * Паузы между попытками прочитать папку, которая молчит (мс).
 *
 * Первая — через полсекунды: системный провайдер, не поднятый к моменту
 * запуска приложения, обычно просыпается именно так быстро. Последняя — через
 * полминуты, и на этом попытки заканчиваются: опрашивать папку, которой нет,
 * до конца заряда батареи — не ответ, а его имитация.
 */
const VAULT_RETRY_MS = [500, 1500, 4000, 10_000, 30_000];

export class AppController {
  private state: AppState;
  private readonly listeners = new Set<Listener>();
  private vault: Vault | null = null;
  private engine: SyncEngine | null = null;
  /**
   * Очередь неотправленного. Живёт при ХРАНИЛИЩЕ, а не при облаке.
   *
   * Заказчик: «работаем локально, пока облако не подключится. А дальше, если
   * локально накопились записки/изменения, то после переключения в онлайн в
   * работу вступает механизм синхронизации».
   *
   * Раньше очередь заводил движок синка, а движок существует только при
   * подключённом месте. Значит всё, что человек писал без облака, нигде не
   * отмечалось как неотправленное: приложение не могло ни показать «столько-то
   * ждёт очереди», ни опереться на этот список при возвращении связи —
   * оставалось сравнивать содержимое и надеяться, что память о прошлом обмене
   * цела. Теперь очередь заводится вместе с хранилищем, переживает перезапуск
   * (она на диске, BEHAVIOR §6) и передаётся движку, когда место появляется.
   */
  private changes: ChangeQueue | null = null;
  /** История версий доступна и без бэкенда: снапшоты лежат в `.zapiski/`. */
  private versions: VersionHistory | null = null;
  private backend: SyncBackend | null = null;
  private readonly crypto = new WebCryptoProvider();
  /** Автозамок: единственный таймер на всё приложение (BEHAVIOR §5.3). */
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private renameTimer: ReturnType<typeof setInterval> | null = null;
  /** Отложенная попытка прочитать папку, которая молчала (см. `retryVault`). */
  private vaultRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Минут до автозамка; `null` — до выхода из приложения. */
  private autoLockMinutes: number | null = 10;
  /**
   * Ключ хранилища: живёт от разблокировки до автозамка и только в памяти.
   * Пока он есть, шифрование новой заметки не требует ни пароля, ни Argon2id.
   */
  private master: MasterKey | null = null;
  /** «Шифровать новые заметки» — читается при старте вместе с автозамком. */
  private encryptNewNotes = false;
  private attachmentPlacement: AttachmentPlacement = 'shared';
  private attachmentNaming: AttachmentNaming = 'hash';
  private attachmentFolder = '';
  /** Ужимать ли крупные изображения. Умолчание из §5 — да. */
  private attachmentDownscale = true;
  /**
   * Показывать папки вложений в библиотеке.
   *
   * По умолчанию — да: спрятанная по умолчанию папка означала бы, что человек
   * не найдёт свои файлы вовсе, а они его. Серый вид уже отделяет их от папок,
   * которые завёл он сам; выключатель — для тех, кому и этого много.
   */
  private attachmentFoldersShown = true;
  /**
   * Показывать ли в открытой папке заметки из вложенных.
   *
   * Выключено по умолчанию: открыл папку — видишь её содержимое, как в любом
   * файловом менеджере. Прежнее поведение (всё вместе, без признаков) читалось
   * как беспорядок и порождало ложный вывод «перенос оставил копию».
   */
  private subfolderNotes = false;
  /**
   * Счётчик неудачных попыток пароля (BEHAVIOR §5.2, SEC-024). До `boot()` —
   * пустой: настоящий приезжает из настроек и переживает перезапуск.
   */
  private guard = UnlockGuard.empty();
  /** Сессия облака: устройство, токены и их обновление по истечении. */
  readonly session: SessionStore;
  /** Отписка от возвратов, которые доставляет оболочка. */
  private authOff: (() => void) | null = null;
  /** Куда вернуться после входа — к тому, ради чего входили (BEHAVIOR §11). */
  private afterSignIn: Route | null = null;

  constructor(
    readonly host: AppHost,
    /** Куда уходят ОО-тосты (BEHAVIOR §0). Провайдер подставляет `useToast`. */
    private toastSink: (toast: ToastRequest) => void = () => {},
    locale: Locale = DEFAULT_LOCALE,
  ) {
    this.state = initialState(locale);
    this.session = new SessionStore(host);
  }

  // ── Подписка ───────────────────────────────────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AppState => this.state;

  get strings(): Strings {
    return buildStrings(this.state.locale);
  }

  setToastSink(sink: (toast: ToastRequest) => void): void {
    this.toastSink = sink;
  }

  private patch(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Тост — единственная форма сообщения о деструктиве (BEHAVIOR §0). */
  toast(toast: ToastRequest): void {
    this.toastSink(toast);
  }

  /**
   * Записать настройку и не потерять отказ.
   *
   * Раньше половина вызовов выглядела как `void this.host.prefs.set(...)`.
   * Отказ записи при этом становился unhandled rejection: переключатель
   * срабатывал, интерфейс показывал новое значение, а на диск не ложилось
   * ничего — и человек узнавал об этом при следующем запуске, когда настройка
   * возвращалась к прежней. Молчаливая потеря выбора запрещена (BEHAVIOR §0:
   * об отказе говорим вслух), поэтому здесь тост, а не тишина.
   */
  protected persistPref<T>(key: string, value: T): void {
    void this.host.prefs.set(key, value).catch(() => {
      this.toast({ message: this.strings.errors.settingNotSaved });
    });
  }

  private undoable(operation: UndoableToast): void {
    this.toast({
      message: operation.message,
      actionLabel: operation.actionLabel,
      onAction: async () => {
        await operation.onAction?.();
        await this.refresh();
      },
    });
  }

  // ── Запуск ─────────────────────────────────────────────────────────────────

  /**
   * Идущая загрузка. Второй вызов `boot()` не начинает новую, а дожидается
   * первой.
   *
   * Защиты не было вовсе, а звать `boot()` дважды приложение умеет: провайдер
   * зовёт его на монтировании, а оболочка может перезагрузить страницу. Два
   * наложившихся прогона гонятся за `this.vault` и заводят по своему набору
   * таймеров в `openVault` — причём таймеры проигравшего никто не остановит.
   */
  private bootRun: Promise<void> | null = null;

  async boot(): Promise<void> {
    this.bootRun ??= this.bootOnce().finally(() => {
      this.bootRun = null;
    });
    return this.bootRun;
  }

  private async bootOnce(): Promise<void> {
    const [
      sortByFolder,
      recentQueries,
      lastOpened,
      account,
      autoLock,
      onboarded,
      unlockGuard,
      encryptNewNotes,
      savedLocale,
      savedPlacement,
      savedNaming,
      savedFolder,
      savedDownscale,
      savedFoldersShown,
      savedSubfolderNotes,
    ] = await Promise.all([
      this.host.prefs.get<Record<string, SortMode>>(PREF.sort, {}),
      this.host.prefs.get<string[]>(PREF.recent, []),
      this.host.prefs.get<VaultPath[]>(PREF.lastOpened, []),
      this.host.prefs.get<AccountState | null>(PREF.account, null),
      this.host.prefs.get<number | null>(PREF.autoLock, 10),
      this.host.prefs.get<boolean>(PREF.onboarded, false),
      this.host.prefs.get<unknown>(PREF.unlockGuard, null),
      this.host.prefs.get<boolean>(PREF.encryptNewNotes, false),
      this.host.prefs.get<unknown>(PREF.locale, null),
      this.host.prefs.get<unknown>(PREF.attachmentPlacement, null),
      this.host.prefs.get<unknown>(PREF.attachmentNaming, null),
      this.host.prefs.get<string>(PREF.attachmentFolder, ''),
      this.host.prefs.get<boolean>(PREF.attachmentDownscale, true),
      this.host.prefs.get<boolean>(PREF.attachmentFoldersShown, true),
      this.host.prefs.get<boolean>(PREF.subfolderNotes, false),
    ]);
    this.autoLockMinutes = autoLock;
    this.encryptNewNotes = encryptNewNotes;
    /* Язык: `setLocale` писал ключ, а читать его было некому — выбор не
       переживал перезапуск (ITERATION-1 §2). Русский по умолчанию, английский
       только явным выбором; локаль ОС не спрашиваем. */
    this.patch({ locale: storedLocale(savedLocale) });
    /* Вложения: правило размещения и имени (ITERATION-1 §5). Мусор в ключе
       откатывается к умолчанию, а не роняет загрузку. */
    if (savedPlacement === 'beside' || savedPlacement === 'custom' || savedPlacement === 'shared') {
      this.attachmentPlacement = savedPlacement;
    }
    if (savedNaming === 'original' || savedNaming === 'date-original' || savedNaming === 'hash') {
      this.attachmentNaming = savedNaming;
    }
    this.attachmentFolder = savedFolder;
    this.attachmentDownscale = savedDownscale;
    this.attachmentFoldersShown = savedFoldersShown;
    this.subfolderNotes = savedSubfolderNotes;
    /* Задержка после неверных попыток продолжает действовать после
       перезапуска, а не начинается заново (BEHAVIOR §5.2, SEC-024). */
    await this.restoreUnlockGuard(unlockGuard);
    this.patch({ sortByFolder, recentQueries, lastOpened, account });

    /* Где лежат заметки — вопрос платформы, а не настроек: место могло быть
       выбрано в прошлый запуск, а разрешение на папку — отозвано (ТЗ §4.1). */
    const vaultLocation = (await this.host.platform.vaultFolders?.current().catch(() => null)) ?? null;
    if (vaultLocation) this.patch({ vaultLocation });

    /* Вход: сессия из настроек и подписка на возврат по ссылке. Делается до
       открытия vault'а — ссылка может прийти в первую же секунду. */
    await this.restoreSession();
    this.listenAuthCallbacks();

    const storage = await this.host.restoreVault().catch(() => null);
    if (!storage && onboarded) {
      /*
       * Место человек уже выбирал, а папка сейчас не отвечает.
       *
       * Онбординг здесь — неправильный ответ, и заказчик показал почему:
       * поставил свежую сборку, выбрал облако и получил системный выбор
       * папки. С его стороны это выглядит как сброс приложения, а сам выбор
       * никуда не девался — не отвечает папка, и, скорее всего, временно.
       *
       * Поэтому остаёмся на списке, называем причину словами реестра
       * (BEHAVIOR §11) и предлагаем то, что помогает: подождать (пробуем сами)
       * или указать папку заново.
       */
      this.patch({ ready: true, booting: false, route: { name: 'list' } });
      this.reportError(this.strings.errors.folderUnavailable);
      this.toast({
        message: this.strings.errors.folderUnavailable,
        actionLabel: this.strings.onboarding.step2.pickFolder,
        onAction: () => this.navigate({ name: 'settings', section: 'sync' }),
      });
      this.scheduleVaultRetry();
      return;
    }
    if (!storage || !onboarded) {
      /* Первый запуск: онбординг с выбором места (SCREENS §1, шаг 2). */
      this.patch({ booting: false, route: { name: 'onboarding', step: 1 } });
      return;
    }
    await this.openVault(storage);
  }

  /** Открыть vault поверх готового хранилища и перейти к списку. */
  async openVault(storage: VaultStorage): Promise<void> {
    this.patch({ booting: true });
    /* Отказ открыть хранилище обязан снять флаг «загружаюсь». Без этого
       состояние врёт о себе: vault не открыт, а приложение считает, что оно
       всё ещё в процессе, — и вызывающий не может ни показать ошибку, ни
       предложить другое место. */
    let vault: Vault;
    try {
      vault = await Vault.open(storage, { locale: this.state.locale });
    } catch (error) {
      this.patch({ booting: false });
      throw error;
    }
    /* Таймеры прежнего vault'а останавливаются ЗДЕСЬ, а не до открытия.
       Остановить их раньше значило бы обезоружить работающее хранилище из-за
       чужой неудачи: не открылась выбранная папка — прежняя осталась на месте,
       но без отложенных переименований и без сторожа автоблокировки. */
    if (this.renameTimer) clearInterval(this.renameTimer);
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.vault = vault;
    this.versions = new VersionHistory(storage);
    /* Очередь неотправленного — вместе с хранилищем: она нужна и тогда, когда
       синхронизировать некуда. Загружаем с диска, чтобы накопленное в прошлый
       раз не начиналось с нуля. */
    const changes = new ChangeQueue(storage);
    await changes.load();
    this.changes = changes;
    vault.onChange(() => {
      void this.refresh();
    });
    /* Отложенные переименования файла по заголовку — 2 с (BEHAVIOR §2.2). */
    this.renameTimer = setInterval(() => {
      void this.flushRenamesNow();
    }, 1000);
    this.startLockWatch();
    await this.refresh();
    this.patch({ ready: true, booting: false, route: { name: 'list' } });
    /*
     * Папка не прочиталась — говорим это, а не показываем пустой список.
     *
     * Заказчик третье утро подряд: «снова утро, снова пустота». Утро — это
     * холодный старт, а на холодном старте системный провайдер папки может
     * быть ещё не поднят. Пустой экран в этот момент — не отчёт о хранилище,
     * а ложное утверждение о нём; вместо него говорится «Папка недоступна…»,
     * и приложение само пробует прочитать её ещё раз.
     */
    if (vault.unreadable) {
      this.reportError(this.strings.errors.folderUnavailable);
      this.scheduleVaultRetry();
    }
    await this.host.prefs.set(PREF.onboarded, true);
    /* Vault открыт — облако можно поднимать: движку синка нужен именно он. */
    await this.resumeCloud();
  }

  /** Хранилище в памяти — запуск без настоящей ФС (демо, тесты, отказ ФС). */
  async openMemoryVault(files?: Record<string, string>): Promise<void> {
    await this.openVault(new MemoryVaultStorage(files ? { files } : {}));
  }

  dispose(): void {
    if (this.lockTimer) clearInterval(this.lockTimer);
    if (this.renameTimer) clearInterval(this.renameTimer);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.vaultRetryTimer) clearTimeout(this.vaultRetryTimer);
    this.authOff?.();
    this.authOff = null;
  }

  // ── Где лежат заметки (ТЗ §2.1.1, §4.1 п. 1, §4.3) ─────────────────────────
  //
  // Android отдаёт чужие папки только через системный выбор (SAF), а поверх
  // дерева `content://` атомарной записи может не быть — значит, формально
  // нарушается §4.3. Раньше мы решали это за пользователя: выбора папки на
  // Android просто не было. Цена оказалась выше: закрывался ключевой
  // бесплатный сценарий §4.1 п. 1 — «LocalFolder, в т.ч. папка, которую
  // синкает сторонний клиент», то есть папка приложения Яндекс.Диска.
  //
  // Теперь выбор есть, а вместе с ним — честное предупреждение. Умолчание не
  // изменилось: каталог приложения с настоящими `.md` и атомарной записью.

  /** Показывать ли выбор папки: платформа даёт его не везде. */
  get canChooseVaultFolder(): boolean {
    return Boolean(this.host.platform.vaultFolders);
  }

  /** Тексты раздела «Где лежат заметки» — из каталога ядра (ТЗ §6). */
  get storageStrings(): Catalog['storage'] {
    return coreCatalog(this.state.locale).storage;
  }

  /**
   * Что нужно честно сказать о текущем месте. `null` — говорить нечего:
   * запись атомарна, поведение обычное.
   */
  get vaultLocationWarning(): string | null {
    const location = this.state.vaultLocation;
    if (!location || location.writeMode === 'atomic') return null;
    const texts = this.storageStrings;
    const note = location.writeMode === 'staged' ? texts.stagedNote : texts.directNote;
    return `${note}. ${texts.why}`;
  }

  /**
   * Системный выбор папки. `null` — выбора нет на этой платформе, человек
   * отменил его либо платформа не смогла его выполнить.
   *
   * ── Почему отмена и отказ разошлись ────────────────────────────────────────
   *
   * Здесь стояло `picker.chooseFolder().catch(() => null)`, то есть ЛЮБАЯ
   * неудача платформы выглядела как «человек передумал»: не поднялся мост в
   * Android, не нашлось приложения-провайдера документов, система убила
   * процесс, пока висел системный выбор, — во всех случаях тап по «Выбрать
   * папку» не делал ровно ничего и не говорил ни слова.
   *
   * Ровно так это и выглядело со стороны: «папка не выбирается». Молчаливый
   * отказ хуже любой ошибки — человек делает вывод, что сломано приложение
   * целиком, и второй раз уже не нажимает.
   *
   * Теперь: `null` от порта — это отмена, и она по-прежнему молчит
   * (BEHAVIOR §0). Исключение — это отказ, и о нём говорится текстом реестра
   * (BEHAVIOR §11).
   */
  async chooseVaultFolder(): Promise<VaultLocationInfo | null> {
    const picker = this.host.platform.vaultFolders;
    if (!picker) return null;

    let chosen: VaultLocation | null;
    try {
      chosen = await picker.chooseFolder();
    } catch {
      this.toast({ message: this.strings.errors.folderUnavailable });
      return null;
    }
    /* Отмена — право человека, и сообщений она не требует. */
    if (!chosen) return null;
    if (!(await this.switchVaultLocation(chosen))) return null;

    /* Итог выбора называется вслух, и вместе с ним — цена, если она есть.
       Предупреждение живёт и в настройках (`vaultLocationWarning`), но сказать
       о нём в момент выбора обязательно: молчание здесь было бы обманом. */
    const warning = this.vaultLocationWarning;
    const chosenText = this.storageStrings.chosen(chosen.label);
    this.toast({ message: warning === null ? chosenText : `${chosenText}. ${warning}` });
    return this.state.vaultLocation;
  }

  /** Вернуться в каталог приложения — надёжный путь с атомарной записью. */
  async useAppVaultFolder(): Promise<VaultLocationInfo | null> {
    const picker = this.host.platform.vaultFolders;
    if (!picker) return null;

    let location: VaultLocation | null;
    try {
      location = await picker.useAppFolder();
    } catch {
      this.toast({ message: this.strings.errors.folderUnavailable });
      return null;
    }
    /* `null` без исключения — платформе нечего предложить. Это тоже отказ:
       кнопку человек нажал, и остаться без ответа он не должен. */
    if (!location) {
      this.toast({ message: this.strings.errors.folderUnavailable });
      return null;
    }
    if (!(await this.switchVaultLocation(location))) return null;
    this.toast({ message: this.storageStrings.returned });
    return this.state.vaultLocation;
  }

  /**
   * Переезд на другое место. Открытые (расшифрованные) заметки при этом
   * закрываются: их содержимое живёт только в памяти и относится к прежнему
   * хранилищу (ТЗ §3.3, BEHAVIOR §5.3).
   *
   * `false` — переезд не состоялся: хранилище не открылось. Название места
   * при этом НЕ меняется. Раньше оно менялось первым, до открытия, и при
   * отказе настройки показывали новую папку, в которой ничего не работает, —
   * то самое «папку выбрал, а ничего не сохраняется». Место в интерфейсе
   * обязано называть то, где заметки лежат на самом деле.
   */
  private async switchVaultLocation(location: VaultLocation): Promise<boolean> {
    this.lockAll();
    try {
      await this.openVault(location.storage);
    } catch {
      this.toast({ message: this.strings.errors.folderUnavailable });
      return false;
    }
    this.patch({
      vaultLocation: { kind: location.kind, writeMode: location.writeMode, label: location.label },
    });
    return true;
  }

  // ── Вход в облако (ТЗ §5.5, SCREENS §2) ────────────────────────────────────
  //
  // Аккаунт нужен ТОЛЬКО для облака: всё, что ниже, может не сработать, и
  // приложение продолжит работать локально. Ни одного SMS-пути здесь нет и
  // быть не может (ARCHITECTURE §3, инвариант 6).

  /** Сессия из настроек. Молча: нет аккаунта — нет и разговора о нём. */
  private async restoreSession(): Promise<void> {
    const session = await this.session.load().catch(() => null);
    if (session === null) return;
    this.patch({
      account: {
        email: session.email,
        plan: this.state.account?.plan ?? 'free',
        marketingOptIn: session.marketingOptIn === true,
      },
    });
  }

  /**
   * Возврат из браузера. Порт необязателен: оболочка, которой нечем принять
   * ссылку, просто его не объявляет — и вход остаётся недоступен только там.
   */
  private listenAuthCallbacks(): void {
    this.authOff?.();
    this.authOff = this.host.onAuthCallback?.((callback) => {
      void this.completeSignIn(callback);
    }) ?? null;

    void this.host
      .takeInitialAuthCallback?.()
      .then((callback) => {
        if (callback !== null && callback !== undefined) return this.completeSignIn(callback);
        return undefined;
      })
      .catch(() => undefined);
  }

  /** Экран входа: запомнить, ради чего входили, и показать его. */
  beginSignIn(returnTo?: Route): void {
    this.afterSignIn = returnTo ?? null;
    this.patch({ authError: null });
    this.navigate({ name: 'signin' });
  }

  /** Письмо со ссылкой (SCREENS §2). Ошибку показывает экран, не модалка. */
  async sendMagicLink(email: string, consents: Consents): Promise<boolean> {
    this.patch({ authError: null });
    try {
      await this.session.requestMagicLink(email, consents);
      return true;
    } catch (error) {
      /* 429 — письмо уже ушло меньше минуты назад. Это не отказ: экран
         показывает то же «письмо ушло» и держит кнопку 60 с (SCREENS §2). */
      if (error instanceof AuthError && error.code === 'too_soon') return true;
      this.patch({ authError: this.authMessage(error) });
      return false;
    }
  }

  /**
   * Умеет ли сервер вход через Яндекс. Экран входа прячет кнопку, если нет:
   * без client_id она уводила в браузер на голый JSON `404`.
   */
  async yandexAvailable(): Promise<boolean> {
    return this.session.yandexAvailable();
  }

  /** Яндекс ID — основной путь входа. Открывается системным браузером. */
  async startYandexSignIn(consents: Consents): Promise<void> {
    this.patch({ authError: null });
    try {
      await this.host.openExternal(await this.session.yandexUrl(consents));
    } catch (error) {
      this.patch({ authError: this.authMessage(error) });
    }
  }

  /**
   * Замкнуть вход тем, что принесла оболочка: обменять токен, сохранить
   * сессию, подключить облако и вернуться туда, ради чего входили.
   */
  async completeSignIn(callback: AuthCallback): Promise<boolean> {
    this.patch({ authBusy: true, authError: null });
    try {
      const session = await this.session.adopt(callback);
      this.setAccount({
        email: session.email,
        plan: this.state.account?.plan ?? 'free',
        /* Согласие приезжает из `/auth/me`: настройки обязаны показывать то,
           что записано на сервере, а не то, что человек нажимал год назад. */
        marketingOptIn: session.marketingOptIn === true,
      });
      this.patch({ authBusy: false });
      await this.connectCloud();
      const back = this.afterSignIn;
      this.afterSignIn = null;
      this.navigate(back ?? { name: 'settings', section: 'sync' }, { replace: true });
      return true;
    } catch (error) {
      /* Ошибка входа не блокирует локальную работу: текст на экране входа. */
      this.patch({ authBusy: false, authError: this.authMessage(error) });
      if (this.state.route.name !== 'signin') this.navigate({ name: 'signin' });
      return false;
    }
  }

  /** Подключить Облако Записок как бэкенд синка. Без сессии — не подключать. */
  async connectCloud(): Promise<boolean> {
    if (this.session.current() === null) return false;
    this.attachBackend(
      createCloudBackend({
        cloudBaseUrl: this.host.cloudBaseUrl,
        session: this.session,
        locale: this.state.locale,
        ...(typeof WebSocket === 'function'
          ? { websocket: (url: string) => new WebSocket(url) }
          : {}),
      }),
    );
    return true;
  }

  /**
   * Яндекс.Диск как бэкенд синка (ТЗ §4.1).
   *
   * Токен здесь — от Диска, а не от входа: вход в аккаунт открывает Облако
   * Записок, а доступ к чужому хранилищу — отдельное разрешение, которого наш
   * OAuth не запрашивает (`server/src/services/yandex.ts`: только `login:*`).
   */
  async connectYandexDisk(token: string): Promise<boolean> {
    if (token.trim() === '') return false;
    await this.host.prefs.set(PREF.yandexToken, token);
    this.attachBackend(new YandexDiskBackend({ token, locale: this.state.locale }));
    return true;
  }

  /**
   * Восстановление бэкенда при старте: как было, так и осталось.
   *
   * «Молчаливым» оно было раньше и в этом состояла беда: не восстановилось —
   * и приложение просто выглядело локальным. Теперь выбор человека попадает в
   * состояние ДО всякой попытки подключиться, а неудача называется вслух.
   */
  private async resumeCloud(): Promise<void> {
    const raw = await this.host.prefs.get<string | null>(PREF.backend, null);
    /* Прежнее имя нашего облака в настройках устройства. Без переноса человек
       с подключённым облаком получил бы после обновления «бэкенд неизвестен»
       и молча отключённый синк — то есть худший из возможных исходов
       переименования. */
    const stored = (raw === 'kompas' ? 'zapiski' : raw) as SyncBackend['id'] | null;
    if (stored !== raw && stored !== null) await this.host.prefs.set(PREF.backend, stored);
    /* Выбор человека — в состояние сразу: экран обязан показывать его, а не
       результат попытки подключиться. */
    this.patch({ backendChoice: stored });
    if (stored === 'yandex') {
      const token = await this.host.prefs.get<string | null>(PREF.yandexToken, null);
      if (token !== null && token !== '') {
        await this.connectYandexDisk(token);
        return;
      }
    }
    if (stored !== null && stored !== 'zapiski') return;
    if (this.session.current() === null) {
      /*
       * Облако выбрано, а входа нет: сессия истекла, была отозвана или не
       * пережила переустановку. Это не повод менять решение человека — это
       * повод сказать, что нужно войти снова. Заметки при этом на месте: они
       * лежат в папке, и приложение продолжает работать локально.
       */
      if (stored === 'zapiski') {
        this.patch({ cloudNeedsSignIn: true });
        this.toast({
          message: this.strings.errors.cloudSignInAgain,
          actionLabel: this.strings.settings.account.signIn,
          onAction: () => this.beginSignIn({ name: 'settings', section: 'sync' }),
        });
      }
      return;
    }
    await this.connectCloud();
  }

  /**
   * Отозвать или снова дать согласие на рекламные письма.
   *
   * Отзыв обязан работать всегда и из одного понятного места: согласие,
   * которое нельзя снять, — не согласие. Ответ сервера кладём в состояние,
   * чтобы тумблер показывал то, что записано на сервере, а не то, что нажали.
   */
  async setMarketingConsent(optIn: boolean): Promise<boolean> {
    const applied = await this.session.setMarketingConsent(optIn).catch(() => null);
    if (applied === null) {
      this.toast({ message: this.strings.errors.syncFailed });
      return this.state.account?.marketingOptIn ?? false;
    }
    const account = this.state.account;
    if (account) this.patch({ account: { ...account, marketingOptIn: applied } });
    return applied;
  }

  /** Выход из аккаунта — одно из ТРЁХ мест с диалогом подтверждения. */
  async signOutCloud(): Promise<void> {
    await this.session.signOut().catch(() => undefined);
    if (this.state.backendId === 'zapiski') this.attachBackend(null);
    this.setAccount(null);
    this.patch({ authError: null });
  }

  clearAuthError(): void {
    this.patch({ authError: null });
  }

  /** Код отказа → текст реестра BEHAVIOR §11. Своих формулировок здесь нет. */
  private authMessage(error: unknown): string {
    const code: AuthErrorCode = error instanceof AuthError ? error.code : 'server';
    const errors = this.strings.errors;
    if (code === 'link_dead') return errors.magicLinkExpired;
    if (code === 'declined') return errors.yandexTokenExpired;
    if (code === 'too_soon') return errors.tryLater;
    return errors.syncFailed;
  }

  // ── Данные ─────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const folders = await vault.folders();
    const notes = vault.notes();
    /*
     * Статус говорит о хранилище, а не только об облаке.
     *
     * Число заметок известно всегда — оно берётся из индекса, а не с той
     * стороны; и число неотправленных известно всегда — очередь живёт при
     * хранилище. Без этого экран настроек без подключённого места показывал
     * «ещё не было · 0 заметок · 0 Б» поверх полной папки — то есть описывал
     * не хранилище, а отсутствие обмена.
     */
    const sync = this.engine ? this.engine.status() : this.state.sync;
    this.patch({
      notes,
      folders,
      tags: vault.index.tagFrequencies(),
      trash: vault.listTrash(),
      sync: { ...sync, noteCount: notes.length, pending: this.pendingCount() },
    });
    /* Открыта папка вложений — перечитываем и её содержимое: вложение только
       что положили туда именно этим действием, и список обязан это показать. */
    const open = this.state.folder;
    if (open !== null && isAttachmentDir(open)) await this.loadFolderFiles(open);
  }

  /**
   * Пересмотреть папку: не появилось ли в ней файлов помимо нас.
   *
   * Заказчик: «если приложение ЗАПИСКИ открыто, то добавленные папки
   * отображаются сразу, а файлы только после перезагрузки приложения».
   * Расхождение объяснялось буквально одной строкой в `refresh()`: папки там
   * берутся с диска (`vault.folders()`), а заметки — из индекса в памяти
   * (`vault.notes()`). Индекс же пересобирается только при открытии
   * хранилища, то есть при запуске приложения.
   *
   * Следить за папкой постоянно мы не можем: у веба этого нет вовсе, а на
   * Android папка живёт за системным провайдером, где уведомлений об
   * изменениях не предусмотрено. Зато есть момент, когда пересмотр и нужен, —
   * человек ушёл в файловый менеджер, скопировал дерево и вернулся. На
   * возвращении и смотрим.
   *
   * Сравниваются наборы путей, а не содержимое: полная пересборка индекса
   * читает каждый файл, и делать её на каждое переключение окна нельзя.
   */
  async rescanVault(): Promise<boolean> {
    const vault = this.vault;
    if (!vault) return false;
    /* Папка молчала — пересматривать нечего, надо сперва её прочитать. */
    if (vault.unreadable) return this.retryVault();
    const onDisk = await vault.notePaths().catch(() => null);
    if (onDisk === null) return false;
    const known = new Set(vault.notes().map((note) => note.path));
    const changed =
      onDisk.length !== known.size || onDisk.some((path) => !known.has(path));
    if (!changed) return false;
    await vault.rebuild();
    await this.refresh();
    return true;
  }

  get vaultRef(): Vault | null {
    return this.vault;
  }

  /**
   * Ещё раз прочитать папку. `true` — получилось.
   *
   * Провайдер, который не ответил на холодном старте, обычно поднимается сам
   * через секунду-другую: ему нужно, чтобы система его запустила. Поэтому
   * правильный ответ на молчание — не «заметок нет», а «сейчас попробуем ещё
   * раз», и сказать об этом вслух.
   */
  async retryVault(): Promise<boolean> {
    const vault = this.vault;
    /* Хранилища нет вовсе — папка не ответила ещё на запуске. Спрашиваем
       платформу заново: это тот же случай, только раньше по времени. */
    if (!vault) {
      const storage = await this.host.restoreVault().catch(() => null);
      if (!storage) return false;
      await this.openVault(storage);
      if (this.vault?.unreadable === true) return false;
      if (this.state.syncError === this.strings.errors.folderUnavailable) this.clearError();
      return true;
    }
    await vault.open().catch(() => undefined);
    if (vault.unreadable) return false;
    await this.refresh();
    if (this.state.syncError === this.strings.errors.folderUnavailable) this.clearError();
    return true;
  }

  /**
   * Повторные попытки прочитать папку, пока она молчит.
   *
   * Паузы растут: первая через полсекунды (провайдер обычно поднимается
   * именно так быстро), последняя — через полминуты. Попытки конечны:
   * бесконечный опрос папки, которой нет, — это разряженная батарея вместо
   * ответа. Дальше остаются возвращение к приложению и кнопка «Повторить».
   */
  private scheduleVaultRetry(attempt = 0): void {
    if (this.vaultRetryTimer) clearTimeout(this.vaultRetryTimer);
    const delay = VAULT_RETRY_MS[attempt];
    if (delay === undefined) return;
    this.vaultRetryTimer = setTimeout(() => {
      this.vaultRetryTimer = null;
      void this.retryVault().then((ok) => {
        if (!ok) this.scheduleVaultRetry(attempt + 1);
      });
    }, delay);
  }

  async readNote(path: VaultPath): Promise<Note | null> {
    const vault = this.vault;
    if (!vault) return null;
    const note = await vault.read(path);
    if (!note) return null;
    /* Зашифрованная заметка отдаётся с телом только после разблокировки. */
    const unlocked = this.state.unlocked[path];
    if (note.encrypted && unlocked) return { ...note, body: unlocked.body };
    return note;
  }

  // ── Навигация ──────────────────────────────────────────────────────────────

  /**
   * Маршруты, которые НЕ кладутся в историю: назад в них возвращаться нельзя.
   *
   * Онбординг — дверь в одну сторону. Он заканчивается курсором в первой
   * заметке и больше не показывается (SCREENS §1); попасть в него «назад» —
   * значит увидеть предложение выбрать хранилище поверх готового хранилища.
   * Найдено живым прогоном: после шифрования два нажатия «Назад» приводили на
   * первый экран онбординга.
   *
   * Экран разблокировки по той же причине: за ним стоит запертая заметка, и
   * возврат в него из списка ничего не открывает.
   */
  private static readonly ONE_WAY: ReadonlySet<Route['name']> = new Set([
    'onboarding',
  ] as const);

  navigate(route: Route, options: { replace?: boolean } = {}): void {
    const oneWay = AppController.ONE_WAY.has(this.state.route.name);
    const stack =
      options.replace || oneWay ? this.state.stack : [...this.state.stack, this.state.route];
    this.patch({
      route,
      stack: stack.slice(-20),
      libraryOpen: false,
      paletteOpen: false,
      /* Чип первого запуска живёт ровно до ухода с первой заметки. */
      firstRun: this.state.firstRun && route.name === 'note',
    });
  }

  /**
   * Онбординг закончен: следующая созданная заметка — первая, и над ней
   * показывается чип шага 3 (SCREENS §1). Отдельного экрана «успех» нет.
   */
  startFirstNote(): void {
    this.patch({ firstRun: true });
  }

  back(): void {
    const stack = [...this.state.stack];
    const previous = stack.pop();
    this.patch({ route: previous ?? { name: 'list' }, stack, infoOpen: false });
  }

  openNote(path: VaultPath): void {
    const lastOpened = [path, ...this.state.lastOpened.filter((item) => item !== path)].slice(0, 5);
    this.patch({ lastOpened });
    this.persistPref(PREF.lastOpened, lastOpened);
    this.navigate({ name: 'note', id: path });
  }

  /**
   * Системное «назад»: кнопка и жест Android, аппаратная клавиша телевизора.
   *
   * ── Зачем это здесь, а не в оболочке ────────────────────────────────────
   *
   * Заказчик: «системная андроидовская кнопка назад должна работать на любом
   * окне приложения. Сейчас меня перекидывает в систему, а не оставляет в
   * приложении». Так и было: Tauri отключает у себя перехват «назад»
   * (`handleBackNavigation = false`), и жест доходил до системы как «закрыть
   * приложение» — из настроек, из заметки, из открытой библиотеки одинаково.
   *
   * Куда возвращаться — вопрос продуктовый, а не платформенный: он про то,
   * что человек считает «предыдущим шагом». Поэтому решение живёт тут, а
   * оболочке остаётся транспорт (ARCHITECTURE §1).
   *
   * Порядок разбора — от самого верхнего слоя к самому нижнему, тот же, что у
   * Esc на клавиатуре: сперва то, что лежит ПОВЕРХ экрана, потом сам экран,
   * потом фильтр списка. Это ровно то, что человек видит последним, — и
   * поэтому ровно то, что он ждёт убрать первым.
   *
   * `false` означает «мне нечего закрывать» — и тогда система уводит из
   * приложения, как и положено на корневом экране. Врать здесь нельзя: вечно
   * удерживаемое «назад» — приложение, из которого не выйти.
   */
  handleSystemBack(): boolean {
    const state = this.state;

    /* Слои поверх экрана. */
    if (state.paletteOpen) {
      this.togglePalette(false);
      return true;
    }
    if (state.shareOpen) {
      this.toggleShare(false);
      return true;
    }
    if (state.debugOpen) {
      this.toggleDebug(false);
      return true;
    }
    if (state.infoOpen) {
      this.toggleInfo(false);
      return true;
    }
    if (state.libraryOpen) {
      this.toggleLibrary(false);
      return true;
    }
    /* Режим фокуса прячет весь хром: «назад» из него — вернуть хром, а не
       уйти из заметки. Иначе человек теряет и то и другое одним движением. */
    if (state.focusMode) {
      this.toggleFocusMode(false);
      return true;
    }

    /* Экран. История ведётся своя (`navigate`), потому что адресной строки на
       Android нет вовсе. */
    if (state.stack.length > 0) {
      this.back();
      return true;
    }
    if (state.route.name !== 'list') {
      /* История пуста, а экран не список: так бывает после «замены» маршрута.
         Возврат к списку — единственный осмысленный шаг назад. */
      this.navigate({ name: 'list' }, { replace: true });
      return true;
    }

    /* Список открыт с фильтром — «назад» снимает фильтр, а не выходит из
       приложения: человек пришёл в папку из «Всех заметок» и возвращается
       туда же. */
    if (state.folder !== null || state.tag !== null) {
      this.openFolder(null);
      return true;
    }

    return false;
  }

  /**
   * Раскрыть или свернуть узел дерева папок.
   *
   * Состояние общее для всех показов библиотеки: на телефоне дерево живёт в
   * ящике, который закрывается на каждом выборе папки, и хранить раскрытие
   * внутри компонента значит терять его при каждом закрытии.
   */
  toggleFolderExpanded(path: string, expanded: boolean): void {
    const current = this.state.expandedFolders;
    if (expanded === current.includes(path)) return;
    this.patch({
      expandedFolders: expanded
        ? [...current, path]
        : current.filter((item) => item !== path),
    });
  }

  openFolder(folder: string | null): void {
    /* Прежние файлы гасим сразу: список, оставшийся от предыдущей папки,
       успевает мигнуть в новой и выглядит как чужие файлы внутри неё. */
    this.patch({ folder, tag: null, scope: 'all', folderFiles: [] });
    /* Открытая папка раскрыта вместе со всеми предками: вернувшись в
       библиотеку, человек видит, где он находится, и видит соседние подпапки —
       а не свёрнутый корень, из которого дорогу надо прокладывать заново. */
    if (folder !== null && folder !== '') this.expandAncestors(folder);
    this.navigate(folder ? { name: 'list', folder } : { name: 'list' });
    if (folder !== null && isAttachmentDir(folder)) void this.loadFolderFiles(folder);
  }

  /** Раскрыть путь целиком: `Практика/Супервизия/2026` — три узла. */
  private expandAncestors(folder: string): void {
    const parts = folder.split('/').filter(Boolean);
    const paths: string[] = [];
    for (let index = 1; index <= parts.length; index += 1) {
      paths.push(parts.slice(0, index).join('/'));
    }
    const missing = paths.filter((path) => !this.state.expandedFolders.includes(path));
    if (missing.length === 0) return;
    this.patch({ expandedFolders: [...this.state.expandedFolders, ...missing] });
  }

  /**
   * Прочитать файлы папки вложений в состояние.
   *
   * Чтение отдельным шагом, а не частью `refresh()` для всех папок: `stat` на
   * каждый файл — обращение к диску, а на Android ещё и к системному
   * провайдеру. Делать это на каждое обновление списка ради папки, которая не
   * открыта, незачем.
   */
  private async loadFolderFiles(folder: string): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const files = await vault.attachmentsIn(folder).catch(() => []);
    /* За время чтения человек мог уйти в другую папку — тогда его список
       перезаписывать нельзя. */
    if (this.state.folder === folder) this.patch({ folderFiles: files });
  }

  /**
   * Открыть файл вложения тем, чем его открывает система.
   *
   * Порядок тот же, что у вложения в тексте (§5): сперва оболочка — ей
   * доступен настоящий путь или `content://`, — и только если она не смогла,
   * `blob:` через браузер. В вебе другого пути нет вовсе.
   */
  /**
   * Адрес для показа вложения на экране приложения.
   *
   * Нужен папке вложений: картинку там открывает наш просмотрщик, а не чужое
   * приложение. Заказчик про папку `Images`: «при клике на неё ничего не
   * происходит» — системе отдавали даже картинку, и когда она отказывалась
   * (а на Android галерея берётся не за всякий `content://`), не происходило
   * ровно ничего. Своя картинка должна открываться у себя.
   *
   * Возвращает `blob:`-адрес; отзывать его — забота вызвавшего.
   */
  async attachmentUrl(path: VaultPath): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    const bytes = await vault.storage.read(path).catch(() => null);
    if (!bytes) {
      this.toast({ message: this.strings.attachments.openFailed });
      return null;
    }
    /* Копия в свой буфер: `Uint8Array` из порта может смотреть в общий пул. */
    const blob = new Blob([bytes.slice() as unknown as BlobPart], { type: attachmentMime(path) });
    return URL.createObjectURL(blob);
  }

  async openAttachmentFile(path: VaultPath): Promise<boolean> {
    const vault = this.vault;
    if (!vault) return false;
    if (await this.host.openAttachment?.(path).catch(() => false)) return true;
    const bytes = await vault.storage.read(path).catch(() => null);
    if (!bytes) {
      this.toast({ message: this.strings.attachments.openFailed });
      return false;
    }
    /* Копия в свой буфер: `Uint8Array` из порта может смотреть в общий пул. */
    const blob = new Blob([bytes.slice() as unknown as BlobPart], { type: attachmentMime(path) });
    const url = URL.createObjectURL(blob);
    try {
      await this.host.openExternal(url);
      return true;
    } catch {
      this.toast({ message: this.strings.attachments.openFailed });
      return false;
    } finally {
      /* Адрес нужен ровно до того, как его подхватит открывшая сторона.
         Отзыв сразу закрыл бы файл у неё под руками, поэтому с задержкой —
         иначе байты каждого открытого файла живут до конца сеанса. */
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  openTag(tag: string): void {
    this.patch({ tag, folder: null, scope: 'all' });
    this.navigate({ name: 'list', tag });
  }

  /**
   * Переименовать тег во всех заметках. ОО-действие: тост с «Отменить»
   * (BEHAVIOR §3). Тег живёт в тексте заметки, поэтому отмена — обратная
   * замена, а не восстановление отдельной записи.
   *
   * Возвращает, скольких заметок коснулась замена.
   */
  async renameTag(from: string, to: string): Promise<number> {
    const vault = this.vault;
    if (!vault) return 0;
    const result = await vault.renameTag(from, to);
    await this.refresh();
    if (!result) return 0;

    const before = from.replace(/^#/, '');
    const after = to.replace(/^#/, '').trim();
    /* Открытый фильтр по старому тегу надо перевести на новый: старого больше
       нет, список опустеет и это будет выглядеть как потеря заметок. Отмена
       ведёт фильтр обратно по той же причине — иначе после «Отменить» человек
       упирается в пустой экран вместо вернувшихся заметок. */
    const following = this.state.tag === before;
    if (following) this.openTag(after);

    this.undoable({
      ...result.undo,
      onAction: async () => {
        await result.undo.onAction?.();
        if (following && this.state.tag === after) this.openTag(before);
      },
    });
    return result.changed;
  }

  /**
   * Вложить изображение: файл едет в `attachments/`, наружу уходит готовая
   * разметка `![](attachments/…)` (BEHAVIOR §2.6).
   *
   * `Vault.addAttachment` был написан и покрыт тестом — и не вызывался НИОТКУДА:
   * ни кнопка «фото» в тулбаре, ни вставка картинки из буфера к нему подключены
   * не были. Строка «Не удалось вставить изображение · Повторить» тоже лежала в
   * реестре с самого начала, и поднять её было нечему.
   *
   * `null` означает неудачу; вызывающий на этом останавливается, а человек
   * видит тост, а не пустоту.
   *
   * Возвращаются оба поля, потому что вызывающим нужно разное: вставка из
   * буфера строит `![](…)` внутри редактора и ждёт ПУТЬ, а тулбар вставляет
   * готовую разметку, которую собрало ядро, — там учтено, картинка это или
   * файл. Возврат чего-то одного заставил бы второго собирать строку вслепую.
   */
  async attachImage(file: File, nearNote?: VaultPath): Promise<{ path: string; markdown: string } | null> {
    const vault = this.vault;
    if (!vault) return null;
    try {
      /* Крупные изображения ужимаются до 2048 px по длинной стороне
         (ITERATION-1 §5). Отказ ужать — не ошибка: тогда кладётся оригинал,
         потому что вложение важнее экономии. */
      const source = this.attachmentDownscale ? ((await downscaleImage(file)) ?? file) : file;
      const bytes = new Uint8Array(await source.arrayBuffer());
      /* Расширение берём из имени файла: тип из `File.type` на Android бывает
         пустым, а имя есть всегда. Умолчание `png` — только для картинки из
         буфера, у которой имени нет вовсе. */
      const dot = file.name.lastIndexOf('.');
      const extension = dot > 0 ? file.name.slice(dot + 1) : 'png';

      /* Куда класть — настройка (ITERATION-1 §5). «Рядом с заметкой» знает
         только вызывающий: путь заметки живёт на экране, а не в контроллере. */
      const options: AddAttachmentOptions = { naming: this.attachmentNaming };
      if (this.attachmentPlacement === 'beside' && nearNote) {
        options.folder = nearNote.includes('/') ? nearNote.slice(0, nearNote.lastIndexOf('/')) : '';
      } else if (this.attachmentPlacement === 'custom' && this.attachmentFolder !== '') {
        options.folder = this.attachmentFolder;
      } else {
        /* Общая папка — это ТРИ папки в корне: Images, Audio, Other files
           (замечание 6). Разбор по расширению, а не по кнопке, которой файл
           выбрали: картинку можно приложить и через «файл», и лечь она должна
           к картинкам. */
        options.folder = attachmentDirFor(extension);
      }
      if (file.name !== '') options.originalName = file.name;

      const result = await vault.addAttachment(bytes, extension, options);
      await this.refresh();
      return result;
    } catch {
      this.toast({ message: this.strings.errors.imageInsertFailed });
      return null;
    }
  }

  /**
   * Обрезать вложенную картинку по рамке (замечание 2).
   *
   * Файл перезаписывается на месте: путь не меняется, и все ссылки на него в
   * заметках остаются рабочими. Это осознанно — «сохранить как копию» плодило
   * бы файлы, о которых человек не просил, а отменить обрезку можно тем же
   * инструментом, заново.
   *
   * `false` — обрезать не вышло (формат не перерисовывается, движок не дал
   * холста, запись не удалась). Молчать в этом случае нельзя: человек видел
   * рамку и ждёт результата, поэтому здесь тост.
   */
  async cropAttachment(path: VaultPath, rect: CropRect): Promise<boolean> {
    const vault = this.vault;
    if (!vault) {
      this.toast({ message: this.strings.errors.folderUnavailable });
      return false;
    }
    try {
      const bytes = await vault.storage.read(path);
      if (!bytes) return false;
      const cropped = await cropImage(bytes, path, rect);
      if (!cropped) {
        this.toast({ message: this.strings.attachments.cropFailed });
        return false;
      }
      await vault.storage.write(path, cropped);
      await this.refresh();
      return true;
    } catch {
      this.toast({ message: this.strings.attachments.cropFailed });
      return false;
    }
  }

  // ── Настройки вложений (ITERATION-1 §5) ────────────────────────────────────
  //
  // «Картинки не вставляются и непонятно, где хранятся; это не настраивается
  // никак» — из письма пользователя. Вставка работала, а вот куда именно
  // ложится файл, узнать было неоткуда: правило было зашито в ядро.

  /** Куда класть вложения: общая папка, рядом с заметкой или своя. */
  attachmentPlacementValue(): AttachmentPlacement {
    return this.attachmentPlacement;
  }

  async setAttachmentPlacement(value: AttachmentPlacement): Promise<void> {
    this.attachmentPlacement = value;
    await this.host.prefs.set(PREF.attachmentPlacement, value);
    this.patch({});
  }

  attachmentNamingValue(): AttachmentNaming {
    return this.attachmentNaming;
  }

  async setAttachmentNaming(value: AttachmentNaming): Promise<void> {
    this.attachmentNaming = value;
    await this.host.prefs.set(PREF.attachmentNaming, value);
    this.patch({});
  }

  attachmentFolderValue(): string {
    return this.attachmentFolder;
  }

  attachmentDownscaleValue(): boolean {
    return this.attachmentDownscale;
  }

  async setAttachmentDownscale(value: boolean): Promise<void> {
    this.attachmentDownscale = value;
    await this.host.prefs.set(PREF.attachmentDownscale, value);
    this.patch({});
  }

  async setAttachmentFolder(value: string): Promise<void> {
    this.attachmentFolder = value.trim();
    await this.host.prefs.set(PREF.attachmentFolder, this.attachmentFolder);
    this.patch({});
  }

  /** Показывать ли служебные папки вложений в дереве библиотеки. */
  attachmentFoldersShownValue(): boolean {
    return this.attachmentFoldersShown;
  }

  /** Показывать ли в открытой папке заметки из вложенных папок. */
  subfolderNotesValue(): boolean {
    return this.subfolderNotes;
  }

  async setSubfolderNotes(value: boolean): Promise<void> {
    this.subfolderNotes = value;
    await this.host.prefs.set(PREF.subfolderNotes, value);
    this.patch({});
  }

  async setAttachmentFoldersShown(value: boolean): Promise<void> {
    this.attachmentFoldersShown = value;
    await this.host.prefs.set(PREF.attachmentFoldersShown, value);
    /* Спрятали папку, в которой человек сейчас стоит, — уводим его к списку
       заметок. Иначе он остаётся на экране папки, которой в дереве больше нет,
       и вернуться в неё нечем. */
    const open = this.state.folder;
    if (!value && open !== null && isAttachmentDir(open)) this.openFolder(null);
    else this.patch({});
  }

  /**
   * Фактический путь, куда сейчас попадёт вложение, — то, что показывается
   * моноширинным внизу раздела настроек. Без него настройка остаётся
   * обещанием: человек выбирает «своя папка» и не видит, что получилось.
   */
  attachmentPathHint(): string {
    if (this.attachmentPlacement === 'beside') return this.strings.attachments.besideHint;
    if (this.attachmentPlacement === 'custom') {
      return this.attachmentFolder === '' ? ATTACHMENTS_DIR : this.attachmentFolder;
    }
    /* «Общая в корне» — это три папки по типу файла, а не одна `attachments`.
       Здесь до сих пор печаталось старое имя, то есть настройка показывала
       путь, по которому вложений уже давно нет: человек шёл искать файлы не
       туда и не находил. */
    return this.strings.attachments.sharedHint;
  }

  // ── Папки (BEHAVIOR, дерево папок) ─────────────────────────────────────────
  //
  // До этого места добраться было нельзя: в меню стояло «Новая подпапка»,
  // которое звало `createNote`, и «Переименовать» с пустым обработчиком
  // `() => undefined`. То есть требование ТЗ существовало на экране в виде
  // надписи и не существовало в виде поведения. Это тот самый класс дефектов,
  // ради которого написан сторож `entry-points.test.ts`.

  /** Создать папку и сразу перейти в неё: иначе непонятно, случилось ли что-то. */
  async createFolder(parent: string, name: string): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    const created = await vault.createFolder(parent, name);
    await this.refresh();
    this.openFolder(created);
    return created;
  }

  /**
   * Переименовать папку. Все заметки внутри переезжают, `[[ссылки]]` на них
   * переписываются — за это отвечает ядро; здесь только состояние экрана.
   */
  async renameFolder(path: string, name: string): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    return this.afterFolderRelocated(path, await vault.renameFolder(path, name));
  }

  /**
   * Переместить папку в другого родителя — «Переместить» из меню (BEHAVIOR §3).
   * Пустая строка означает корень хранилища.
   */
  async moveFolder(path: string, parent: string): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    return this.afterFolderRelocated(path, await vault.moveFolder(path, parent));
  }

  /**
   * Общий хвост переименования и перемещения: папка сменила путь, и вслед за
   * ней надо перевести всё, что на неё смотрело.
   *
   * Тот самый класс «состояние держит старый путь»: открытая заметка внутри
   * папки после переезда лежит по новому адресу, и если экран этого не узнает,
   * следующее автосохранение создаст файл заново по старому.
   */
  private async afterFolderRelocated(
    path: string,
    result: { to: string; updatedLinks: number },
  ): Promise<string> {
    if (this.state.route.name === 'note' && this.state.route.id.startsWith(`${path}/`)) {
      this.noteMoved(this.state.route.id, `${result.to}${this.state.route.id.slice(path.length)}`);
    }
    if (this.state.folder === path) this.patch({ folder: result.to });
    await this.refresh();
    if (result.updatedLinks > 0) {
      this.toast({ message: this.strings.errors.linksUpdated(result.updatedLinks) });
    }
    return result.to;
  }

  /**
   * Удалить папку. Заметки внутри уезжают в корзину — ТЗ обещает, что ни одно
   * действие не теряет текст безвозвратно, и папка не исключение. Поэтому же
   * тост говорит, сколько заметок отправилось в корзину, а не молчит.
   */
  async deleteFolder(
    path: string,
    mode: 'notes-to-trash' | 'notes-to-parent' = 'notes-to-trash',
  ): Promise<number> {
    const vault = this.vault;
    if (!vault) return 0;
    const trashed = await vault.deleteFolder(path, mode);
    if (this.state.folder === path) this.openFolder(null);
    if (this.state.route.name === 'note' && this.state.route.id.startsWith(`${path}/`)) {
      this.navigate({ name: 'list' }, { replace: true });
    }
    await this.refresh();
    if (trashed.length > 0 && mode === 'notes-to-trash') {
      this.toast({ message: this.strings.library.folderTrashed(trashed.length) });
    }
    return trashed.length;
  }

  openSettings(section: SettingsSection = 'appearance'): void {
    this.navigate({ name: 'settings', section });
  }

  setScope(scope: ListScope): void {
    this.patch({ scope, folder: null, tag: null });
  }

  toggleLibrary(open?: boolean): void {
    this.patch({ libraryOpen: open ?? !this.state.libraryOpen });
  }

  togglePalette(open?: boolean): void {
    this.patch({ paletteOpen: open ?? !this.state.paletteOpen });
  }

  toggleInfo(open?: boolean): void {
    this.patch({ infoOpen: open ?? !this.state.infoOpen });
  }

  toggleFocusMode(on?: boolean): void {
    this.patch({ focusMode: on ?? !this.state.focusMode });
  }

  toggleRawMode(on?: boolean): void {
    this.patch({ rawMode: on ?? !this.state.rawMode });
  }

  toggleDebug(open?: boolean): void {
    this.patch({ debugOpen: open ?? !this.state.debugOpen });
  }

  toggleShare(open?: boolean): void {
    this.patch({ shareOpen: open ?? !this.state.shareOpen });
  }

  // ── Заметки ────────────────────────────────────────────────────────────────

  /**
   * Новая заметка. При включённом «Шифровать новые заметки» — сразу
   * зашифрованная, без единого вопроса: пароль хранилища задан один раз
   * (ТЗ §3.3).
   *
   * Если хранилище заперто, заметка создаётся обычной. Это не уступка, а
   * выбор из двух зол: молча создать открытый файл вместо обещанного
   * зашифрованного нельзя, а прервать набор мысли модальным окном пароля —
   * прямое нарушение «ноль трения» (§2 продукта). Поэтому тумблер в
   * настройках честно говорит, что действует при открытом хранилище.
   */
  async createNote(folder?: string, title?: string): Promise<VaultPath | null> {
    const vault = this.vault;
    /* Молчаливый отказ хуже любой ошибки: человек жмёт «плюс», ничего не
       происходит, и он делает вывод, что приложение сломано целиком. Так и
       было описано в отзыве — «невозможно создать новую». Хранилища нет ровно
       в одном случае: папка недоступна, — про это и говорим словами реестра. */
    if (!vault) {
      this.toast({ message: this.strings.errors.folderUnavailable });
      return null;
    }

    const master = this.master;
    if (this.encryptNewNotes && master) {
      const plain = vault.freePath(folder ?? '', title ?? this.strings.notes.untitled);
      const body = title ? `# ${title}\n\n` : '';
      /* Именно `createEncryptedNote`, а не «создать и зашифровать»: второе
         положило бы открытый текст на диск между двумя операциями. */
      const target = await createEncryptedNote(vault.storage, this.crypto, plain, master, body);
      await vault.rebuild();
      await this.refresh();
      const data = await vault.storage.read(target);
      const keyId = data ? this.crypto.parseHeader(data)?.keyId : undefined;
      if (keyId) this.putUnlocked(target, body, await this.crypto.deriveNoteKey(master, keyId));
      this.scheduleSync(target);
      this.openNote(target);
      return target;
    }

    const note = await vault.create({
      ...(folder ? { folder } : {}),
      ...(title ? { title } : {}),
    });
    /* Новая заметка — тоже изменение, которое ждёт отправки: без этой строки
       она попадала в облако только следующей правкой, а до тех пор нигде не
       числилась. */
    this.scheduleSync(note.path);
    await this.refresh();
    this.openNote(note.path);
    return note.path;
  }

  /**
   * Тик таймера переименований — и всё, что обязано случиться следом.
   *
   * Отдельным методом, а не телом `setInterval`, по двум причинам. Во-первых,
   * его можно вызвать в тесте: раньше тесты дёргали `vault.flushRenames()`
   * напрямую и потому не видели, куда после переименования смотрит само
   * приложение. Во-вторых, здесь живёт то, чего в теле таймера не было и
   * из-за чего заметки размножались.
   *
   * Что происходило. Заметка рождается как «Без названия.md». Через две
   * секунды vault переименовывает файл по заголовку (BEHAVIOR §2.2) — выходит
   * «Привет!.md». Экран продолжал держать СТАРЫЙ путь, и следующее
   * автосохранение писало по нему: `write` создавал файл заново. Дальше цикл
   * повторялся, а раз «Привет!.md» уже занят, следующее переименование давало
   * «Привет! 2.md». Пользователь просто печатал, а заметки плодились.
   */
  async flushRenamesNow(force = false): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const results = await vault.flushRenames(force);
    if (results.length === 0) return;

    for (const result of results) {
      if (result.renamed) this.noteMoved(result.from, result.to);
    }

    const updated = results.reduce((sum, result) => sum + result.updatedLinks, 0);
    if (updated > 0) this.toast({ message: this.strings.errors.linksUpdated(updated) });
    await this.refresh();
  }

  /**
   * Единственное место, где приложение узнаёт, что заметка сменила путь.
   *
   * Отдельным методом, потому что путь меняется НЕ в одном месте:
   * переименование по заголовку, перемещение в папку, шифрование и снятие
   * шифрования, восстановление из корзины. Размножение заметок случилось
   * ровно потому, что следование за путём было написано (точнее, не написано)
   * по месту в одном из них. Каждый новый способ сдвинуть файл обязан звать
   * этот метод, а `path-follow.test.ts` перечисляет их списком.
   */
  private noteMoved(from: VaultPath, to: VaultPath): void {
    if (from === to) return;
    /* Переезды помним недолго, но помним: правка редактора уходит по debounce
       500 мс, а таймер тикает раз в секунду — сохранение вполне может
       прилететь уже со старым путём. `save` проводит путь через эту карту и
       попадает в живой файл, а не создаёт покойника заново. */
    this.recentRenames.set(from, to);
    if (this.state.route.name === 'note' && this.state.route.id === from) {
      this.patch({ route: { name: 'note', id: to } });
    }
    if (this.state.lastOpened.includes(from)) {
      /* Список недавних тоже держит пути. Оставить в нём покойника значит
         показать в «недавних» строку, которая никуда не открывается. */
      const lastOpened = this.state.lastOpened.map((item) => (item === from ? to : item));
      this.patch({ lastOpened });
      this.persistPref(PREF.lastOpened, lastOpened);
    }
  }

  /** Куда переехали недавно переименованные файлы. Ключ — старый путь. */
  private readonly recentRenames = new Map<VaultPath, VaultPath>();

  /**
   * «Это та же самая заметка, просто переехала?»
   *
   * Нужно экрану заметки. Он перечитывает содержимое с диска, когда меняется
   * путь, — и это правильно, если человек открыл другую заметку. Но при
   * переименовании по заголовку путь меняется у ТОЙ ЖЕ заметки, а в редакторе
   * уже лежит текст свежее дискового: между сохранением и переименованием
   * человек продолжает печатать. Перечитывание в этот момент затирает
   * набранное и уводит курсор — со стороны это выглядит как «текст
   * смещается», и именно на это пожаловался пользователь.
   */
  movedFrom(previous: VaultPath | null, current: VaultPath): boolean {
    if (previous === null || previous === current) return false;
    return this.recentRenames.get(previous) === current;
  }

  /**
   * Куда на самом деле писать, если путь пришёл из редактора со сдвигом.
   *
   * Здесь легко сделать хуже, чем было, и я сделал: первая версия слепо
   * проводила путь через карту переездов. Но «Без названия.md» — имя
   * ПОВТОРНО ИСПОЛЬЗУЕМОЕ: следующая новая заметка рождается с ним же. Слепая
   * подстановка отправляла её текст в файл предыдущей заметки и затирала
   * чужое содержимое. Диагностика показала это прямо: на диске оставались
   * «Без названия.md» и «Своя.md», а текст «Своей» уехал в «Чужую».
   *
   * Поэтому правило теперь такое: **существующий файл всегда главнее карты**.
   * Карта отвечает на вопрос «куда делся файл, которого больше нет», и только
   * на него. Если по запрошенному пути что-то лежит — пишем туда и не
   * умничаем.
   */
  private async resolveSavePath(requested: VaultPath): Promise<VaultPath> {
    const vault = this.vault;
    if (!vault) return requested;
    /* Спрашиваем хранилище, а не индекс: индекс — производная и может
       отставать на такт, а ошибка здесь стоит чужого текста. */
    if ((await vault.storage.stat(requested)) !== null) {
      /* Путь занят — значит, это живой файл, а запись в карте протухла. */
      this.recentRenames.delete(requested);
      return requested;
    }
    let current = requested;
    for (let step = 0; step < 8; step += 1) {
      const next = this.recentRenames.get(current);
      if (next === undefined || next === current) break;
      current = next;
    }
    return current;
  }

  /**
   * Автосохранение (BEHAVIOR §0): вызывается редактором по debounce 500 мс и
   * на blur. Слова «Сохранить» в UI нет — кнопки, вызывающей это, не существует.
   */
  async save(requested: VaultPath, body: string): Promise<void> {
    const vault = this.vault;
    /* Хранилища нет — писать некуда, и молчать об этом нельзя: человек
       набирает текст и считает, что он сохраняется. Ровно это и описано как
       «по факту ничего не сохраняется». Сообщение живёт в статусе, а не в
       тосте: автосохранение срабатывает каждые полсекунды, и тост превратился
       бы в мигающую стену (приёмочный критерий №5 — ввод не трогаем). */
    if (!vault) {
      this.reportError(this.strings.errors.folderUnavailable);
      return;
    }
    const path = await this.resolveSavePath(requested);
    const unlocked = this.state.unlocked[path];
    if (unlocked) {
      /* Зашифрованная заметка: открытый текст на диск не попадает никогда. */
      this.patch({
        unlocked: { ...this.state.unlocked, [path]: { ...unlocked, body } },
      });
      try {
        await encryptNoteFileSafely(vault, this.crypto, path, body, unlocked.key);
      } catch (error) {
        /* Тот же разговор, что и с открытой заметкой: отказ диска слышен.
           Раньше он улетал необработанным отказом промиса — то есть в никуда. */
        this.reportError(diskErrorMessage(error, this.strings));
        return;
      }
      this.touchLock(path);
      return;
    }
    try {
      await vault.write(path, body);
    } catch (error) {
      /* Диск не принял запись — сообщаем в статусе, ввод не трогаем. */
      this.reportError(diskErrorMessage(error, this.strings));
      return;
    }
    this.scheduleSync(path);
  }

  async setPinned(path: VaultPath, pinned: boolean): Promise<void> {
    await this.vault?.setPinned(path, pinned);
    await this.refresh();
  }

  /** Архивация — ОО (BEHAVIOR §1.1). */
  async archive(path: VaultPath, archived = true): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    if (archived) {
      this.undoable(await vault.archiveWithUndo(path));
    } else {
      await vault.setArchived(path, false);
    }
    await this.refresh();
  }

  /** Удаление — ОО + корзина 30 дней (BEHAVIOR §0). */
  async trashNote(path: VaultPath): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const operation = await vault.trash(path);
    this.undoable(operation);
    if (this.state.route.name === 'note' && this.state.route.id === path) this.back();
    await this.refresh();
  }

  async restoreFromTrash(entryId: string): Promise<void> {
    await this.vault?.restore(entryId);
    await this.refresh();
  }

  /** Очистка корзины — одно из ТРЁХ мест с диалогом подтверждения. */
  async purgeTrash(): Promise<number> {
    const removed = (await this.vault?.purgeTrash(true)) ?? 0;
    await this.refresh();
    return removed;
  }

  async duplicate(path: VaultPath): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const note = await vault.read(path);
    if (!note || note.encrypted) return;
    const copy = await vault.create({ body: note.body, folder: folderOf(path) });
    await this.refresh();
    this.openNote(copy.path);
  }

  async move(path: VaultPath, folder: string): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const result = await vault.move(path, folder);
    /* Перемещение — такая же смена пути, как переименование по заголовку.
       Без этой строки открытая заметка оставалась бы на старом пути, и
       следующее автосохранение создало бы её заново в корне — ровно то
       размножение, которое нашёл пользователь, только другим способом. */
    if (result.renamed) this.noteMoved(result.from, result.to);
    await this.refresh();
    if (result.updatedLinks > 0) {
      this.toast({ message: this.strings.errors.linksUpdated(result.updatedLinks) });
    }
  }

  // ── История версий (BEHAVIOR §6, SCREENS §10b `4h`) ────────────────────────

  async versionsFor(noteId: string): Promise<VersionSnapshot[]> {
    return (await this.versions?.list(noteId)) ?? [];
  }

  /** «Восстановить эту версию» — ОО: 6-секундный тост с «Отменить». */
  async restoreVersion(path: VaultPath, body: string): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const previous = (await vault.read(path))?.body ?? '';
    await vault.write(path, body);
    await this.refresh();
    this.toast({
      message: this.strings.versions.restored,
      actionLabel: this.strings.actions.undo,
      onAction: async () => {
        await vault.write(path, previous);
        await this.refresh();
      },
    });
  }

  // ── Поиск (BEHAVIOR §4) ────────────────────────────────────────────────────

  /** Ввод в строке поиска: debounce 120 мс, запрос <2 символов не ищется. */
  setQuery(query: string): void {
    this.patch({ query });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.runSearch(query);
    }, 120);
  }

  private runSearch(raw: string): void {
    const vault = this.vault;
    const parsed = parseQuery(raw);
    const hasFilters = Object.keys(parsed.filters).length > 0;
    if (!vault || (parsed.text.trim().length < 2 && !hasFilters)) {
      this.patch({ results: [] });
      return;
    }
    this.patch({ results: vault.index.search(parsed, 200) });
  }

  /** Запомнить запрос в «НЕДАВНИЕ» (до 8, BEHAVIOR §4). */
  rememberQuery(query: string): void {
    const trimmed = query.trim();
    if (trimmed === '') return;
    const recentQueries = [
      trimmed,
      ...this.state.recentQueries.filter((item) => item !== trimmed),
    ].slice(0, 8);
    this.patch({ recentQueries });
    this.persistPref(PREF.recent, recentQueries);
  }

  // ── Сортировка (BEHAVIOR §1.2 — на папку) ──────────────────────────────────

  sortModeFor(folder: string | null): SortMode {
    return this.state.sortByFolder[folder ?? ''] ?? 'updated';
  }

  setSortMode(folder: string | null, mode: SortMode): void {
    const sortByFolder = { ...this.state.sortByFolder, [folder ?? '']: mode };
    this.patch({ sortByFolder });
    this.persistPref(PREF.sort, sortByFolder);
  }

  // ── Шифрование (BEHAVIOR §5) ───────────────────────────────────────────────

  isUnlocked(path: VaultPath): boolean {
    return this.state.unlocked[path] !== undefined;
  }

  unlockedNote(path: VaultPath): { body: string; lockAt: number } | null {
    const entry = this.state.unlocked[path];
    return entry ? { body: entry.body, lockAt: entry.lockAt } : null;
  }

  async hintFor(path: VaultPath): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    return passwordHint(vault.storage, this.crypto, path);
  }

  /**
   * Задержка после неудачных попыток: 1–4 без задержки, 5-я — 30 с, 8-я — 5 мин.
   *
   * Считает `UnlockGuard`: он сверяет монотонные часы со стенными, поэтому
   * перевод часов устройства задержку не сокращает (SEC-024).
   */
  get unlockDelayLeftMs(): number {
    return this.guard.delayLeftMs();
  }

  /**
   * Поднять счётчик попыток из настроек и сохранить приведённую запись.
   *
   * Сохранение обязательно: `restore` мог поправить запись (например, часы
   * ушли назад и задержка взведена заново) — без записи эту поправку было бы
   * достаточно перезапуска, чтобы отменить.
   */
  private async restoreUnlockGuard(stored: unknown): Promise<void> {
    this.guard = UnlockGuard.restore(stored);
    const record = this.guard.record;
    this.patch({ failedAttempts: record.failedAttempts, lockedUntil: record.lockedUntil });
    await this.saveUnlockGuard(record);
  }

  /**
   * Записать счётчик в настройки. Ошибка записи не должна ронять разблокировку:
   * задержка в этом случае деградирует до внутрисеансовой, но заметка
   * открывается, а данные не трогаются никогда (BEHAVIOR §5.2).
   */
  private async saveUnlockGuard(record: UnlockGuardRecord): Promise<void> {
    await this.host.prefs.set(PREF.unlockGuard, record).catch(() => undefined);
  }

  /**
   * Есть ли у хранилища пароль. Соль — единственный признак: она появляется
   * ровно при установке шифрования и живёт, пока есть хоть одна зашифрованная
   * заметка.
   */
  async hasVaultPassword(): Promise<boolean> {
    return (await this.vaultSalt()) !== null;
  }

  /** Открыто ли хранилище прямо сейчас (ключ в памяти, автозамок не сработал). */
  get vaultUnlocked(): boolean {
    return this.master !== null;
  }

  /**
   * Соль хранилища — та, из которой выводится ключ.
   *
   * Ищется по трём местам подряд, и порядок здесь важнее самих мест:
   *   1. память сеанса;
   *   2. `.zapiski/crypto.json` — служебный файл, который синк НЕ переносит;
   *   3. заголовок любой зашифрованной заметки.
   *
   * Третий пункт и делает второе устройство работоспособным: `.zapiski/`
   * восстановим по построению и не синкается, а вот сама заметка приезжает —
   * и приносит соль с собой. Поэтому пароль, заданный на телефоне, открывает
   * заметку на десктопе без всякой передачи ключей.
   */
  private async vaultSalt(): Promise<Uint8Array | null> {
    if (this.master) return this.master.salt;
    const vault = this.vault;
    if (!vault) return null;

    const stored = await readJson<{ salt: string }>(vault.storage, VAULT_KEY_PATH);
    if (stored?.salt) {
      try {
        return fromBase64(stored.salt);
      } catch {
        /* Файл побит — не беда: соль всё равно лежит в каждом контейнере. */
      }
    }

    for (const note of this.state.notes) {
      if (!note.encrypted) continue;
      const data = await vault.storage.read(note.path);
      const header = data ? this.crypto.parseHeader(data) : null;
      if (header) return header.salt;
    }
    return null;
  }

  private async rememberVaultSalt(salt: Uint8Array): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    /* Ошибка записи не фатальна: соль есть в каждом контейнере, файл — лишь
       ускорение для случая «зашифрованных заметок ещё нет». */
    await writeJsonAtomic(vault.storage, VAULT_KEY_PATH, { version: 1, salt: toBase64(salt) }).catch(
      () => undefined,
    );
  }

  /**
   * Задать пароль хранилища — ОДИН раз, при первом шифровании (ТЗ §3.3).
   *
   * Дальше пароль не спрашивается ни при шифровании новой заметки, ни при
   * шифровании существующей: спрашивают его только замок и смена пароля.
   */
  async setVaultPassword(password: string, enrollBiometrics = false): Promise<boolean> {
    const vault = this.vault;
    if (!vault) return false;
    const salt = (await this.vaultSalt()) ?? this.crypto.randomSalt();
    const material = await this.crypto.deriveMasterMaterial(password, salt);
    this.master = await this.crypto.importMaster(material, salt);
    await this.rememberVaultSalt(salt);
    if (enrollBiometrics) await this.enrollBiometrics(material);
    material.fill(0);
    return true;
  }

  /**
   * Ключевой материал — в платформенное хранилище (ТЗ §3.3: «биометрия
   * открывает master key»). Туда уезжает материал, а НЕ пароль: пароль
   * человек может использовать где-то ещё, а материал бесполезен вне этого
   * vault'а. Побочная выгода — разблокировка биометрией не гоняет Argon2id и
   * потому мгновенна.
   */
  private async enrollBiometrics(material: Uint8Array): Promise<boolean> {
    const biometrics = this.host.platform.biometrics;
    if (!biometrics) return false;
    return biometrics
      .enroll(VAULT_KEY_ID, material)
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Зашифровать существующую заметку. Пароль уже задан — вопросов нет.
   *
   * Путь проводится через `resolveSavePath` по той же причине, по какой это
   * делает автосохранение: заметка переименовывает себя по заголовку через
   * две секунды после набора (BEHAVIOR §2.2), а меню держит путь, взятый до
   * переименования. Живой прогон ловит это как исключение «Нет такой
   * заметки» ровно в тот момент, когда человек напечатал заголовок и сразу
   * полез шифровать, — то есть в самый обычный.
   */
  async encryptNote(path: VaultPath, hint?: string): Promise<VaultPath | null> {
    const vault = this.vault;
    const master = this.master;
    if (!vault || !master) return null;
    const source = await this.resolveSavePath(path);
    if ((await vault.storage.stat(source)) === null) return null;
    const target = await encryptNoteFile(vault.storage, this.crypto, source, master, hint);
    await vault.rebuild();
    await this.refresh();
    const body = (await decryptNoteFile(vault.storage, this.crypto, target, master)) ?? '';
    const data = await vault.storage.read(target);
    const keyId = data ? this.crypto.parseHeader(data)?.keyId : undefined;
    if (keyId) this.putUnlocked(target, body, await this.crypto.deriveNoteKey(master, keyId));
    /* Путь сменился — экран обязан пойти следом, иначе он держит файл,
       которого больше нет (та же механика, что у переименования). */
    this.noteMoved(source, target);
    if (this.state.route.name === 'note' && (this.state.route.id === path || this.state.route.id === source)) {
      this.navigate({ name: 'note', id: target }, { replace: true });
    }
    return target;
  }

  /**
   * Разблокировка паролем. `null` — пароль не подошёл: точки возвращаются,
   * подпись «Пароль не подошёл», данные не удаляются никогда.
   *
   * Пароль здесь один на хранилище: Argon2id прогоняется один раз за сеанс, а
   * ключ каждой следующей заметки выводится из master мгновенно.
   */
  async unlock(path: VaultPath, password: string): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    if (this.unlockDelayLeftMs > 0) return null;
    const data = await vault.storage.read(path);
    const header = data ? this.crypto.parseHeader(data) : null;
    if (!header) return null;

    /* Соль версии 2 — общая соль хранилища и лежит прямо в контейнере.
       У версии 1 соль своя, поэтому master для сеанса выводится отдельно. */
    const master =
      header.version === LEGACY_CONTAINER_VERSION
        ? await this.crypto.deriveMaster(password, (await this.vaultSalt()) ?? this.crypto.randomSalt())
        : await this.crypto.deriveMaster(password, header.salt);
    const body = await decryptNoteFile(vault.storage, this.crypto, path, master, password);
    if (body === null) {
      /* Счётчик и конец задержки уезжают в настройки СРАЗУ: перезапуск между
         попытками не должен их обнулять (SEC-024). */
      const record = this.guard.registerFailure();
      this.patch({ failedAttempts: record.failedAttempts, lockedUntil: record.lockedUntil });
      await this.saveUnlockGuard(record);
      return null;
    }
    const reset = this.guard.reset();
    this.patch({ failedAttempts: 0, lockedUntil: 0 });
    await this.saveUnlockGuard(reset);
    this.master = master;
    await this.rememberVaultSalt(master.salt);
    await this.adoptUnlocked(path, body, master);
    this.host.platform.haptics?.impact('light');
    return body;
  }

  /**
   * Открыть зашифрованную заметку при УЖЕ открытом хранилище — без пароля.
   *
   * Это и есть выигрыш иерархии для человека: пароль спрашивают один раз за
   * сеанс, а не на каждую запертую заметку. `null` — хранилище заперто или
   * заметка версии 1, которую ключ хранилища не открывает: тогда показывается
   * замок, как и раньше.
   */
  async openEncrypted(path: VaultPath): Promise<string | null> {
    const vault = this.vault;
    const master = this.master;
    if (!vault || !master) return null;
    const body = await decryptNoteFile(vault.storage, this.crypto, path, master);
    if (body === null) return null;
    await this.adoptUnlocked(path, body, master);
    return body;
  }

  /**
   * Положить расшифрованную заметку в память и заодно перевести её на версию 2,
   * если она была версии 1.
   *
   * Миграция ленивая и молчаливая: текст уже расшифрован, второй Argon2id не
   * нужен, а если запись не удалась — файл остаётся версии 1 и продолжает
   * открываться тем же паролем. Ни одного состояния, в котором заметка
   * перестаёт открываться, здесь нет.
   */
  private async adoptUnlocked(path: VaultPath, body: string, master: MasterKey): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    await rewriteToCurrentVersion(vault.storage, this.crypto, path, master, body).catch(() => false);
    const data = await vault.storage.read(path);
    const keyId = data ? this.crypto.parseHeader(data)?.keyId : undefined;
    if (!keyId) return;
    this.putUnlocked(path, body, await this.crypto.deriveNoteKey(master, keyId));
  }

  /**
   * Сменить пароль хранилища (ТЗ §3.3, единственное место, где он меняется).
   *
   * Ключ выводится из пароля, поэтому смена пароля означает перешифровку всех
   * заметок. Дорого это только на вид: Argon2id гоняется дважды на всю
   * операцию — для старого ключа и для нового, — а каждая заметка стоит одного
   * AES-прохода.
   *
   * Обрыв на середине не ломает ничего: каждый контейнер несёт СВОЮ соль,
   * поэтому недописанные заметки продолжают открываться старым паролем. Их
   * пути возвращаются вызывающему, чтобы экран назвал их поимённо, а не
   * промолчал.
   */
  async changeVaultPassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean; changed: number; failed: VaultPath[] }> {
    const vault = this.vault;
    const salt = await this.vaultSalt();
    if (!vault || !salt) return { ok: false, changed: 0, failed: [] };

    const oldMaster = await this.crypto.deriveMaster(oldPassword, salt);
    const paths = this.state.notes.filter((note) => note.encrypted).map((note) => note.path);

    /* Проверка пароля до единой записи: иначе неверный старый пароль
       превратил бы «не подошёл» в наполовину перешифрованное хранилище. */
    const first = paths[0];
    if (first !== undefined) {
      const probe = await decryptNoteFile(vault.storage, this.crypto, first, oldMaster, oldPassword);
      if (probe === null) {
        const record = this.guard.registerFailure();
        this.patch({ failedAttempts: record.failedAttempts, lockedUntil: record.lockedUntil });
        await this.saveUnlockGuard(record);
        return { ok: false, changed: 0, failed: [] };
      }
    }

    const newSalt = this.crypto.randomSalt();
    const material = await this.crypto.deriveMasterMaterial(newPassword, newSalt);
    const newMaster = await this.crypto.importMaster(material, newSalt);

    const failed: VaultPath[] = [];
    let changed = 0;
    for (const path of paths) {
      const body = await decryptNoteFile(vault.storage, this.crypto, path, oldMaster, oldPassword);
      if (body === null) {
        failed.push(path);
        continue;
      }
      const key = await this.crypto.deriveNoteKey(newMaster, this.crypto.randomKeyId());
      const hint = (await vault.storage.read(path).then((data) => (data ? this.crypto.parseHeader(data)?.hint : undefined))) ?? undefined;
      try {
        await writeAtomic(vault.storage, path, await this.crypto.encrypt(body, key, hint));
        changed += 1;
      } catch {
        failed.push(path);
      }
    }

    this.master = newMaster;
    await this.rememberVaultSalt(newSalt);
    /* Открытые заметки закрываются: их ключи выведены из прежнего master. */
    this.patch({ unlocked: {} });
    if (this.host.platform.biometrics) await this.enrollBiometrics(material);
    material.fill(0);
    return { ok: true, changed, failed };
  }

  /**
   * Разблокировка биометрией. Отмена пользователем — не ошибка (BEHAVIOR §5.2).
   *
   * Из платформенного хранилища приходит ключевой материал, а не пароль:
   * Argon2id не запускается вовсе, поэтому заметка открывается мгновенно —
   * ровно то, ради чего ТЗ §3.3 и требует «биометрия открывает master key».
   */
  async unlockWithBiometrics(path: VaultPath): Promise<string | null> {
    const biometrics = this.host.platform.biometrics;
    const vault = this.vault;
    if (!biometrics || !vault) return null;
    const material = await biometrics.unlock(VAULT_KEY_ID).catch(() => null);
    if (!material) return null;
    const salt = await this.vaultSalt();
    if (!salt) return null;
    const master = await this.crypto.importMaster(material, salt);
    material.fill(0);
    const body = await decryptNoteFile(vault.storage, this.crypto, path, master);
    if (body === null) return null;
    this.master = master;
    await this.adoptUnlocked(path, body, master);
    this.host.platform.haptics?.impact('light');
    return body;
  }

  /** Включить или выключить биометрию для хранилища (раздел «Безопасность»). */
  async setBiometricsEnabled(on: boolean, password?: string): Promise<boolean> {
    const biometrics = this.host.platform.biometrics;
    if (!biometrics) return false;
    if (!on) {
      await biometrics.remove(VAULT_KEY_ID).catch(() => undefined);
      await this.host.prefs.set(PREF.biometrics, false);
      return true;
    }
    const salt = await this.vaultSalt();
    if (!salt || password === undefined) return false;
    const material = await this.crypto.deriveMasterMaterial(password, salt);
    const ok = await this.enrollBiometrics(material);
    material.fill(0);
    if (ok) await this.host.prefs.set(PREF.biometrics, true);
    return ok;
  }

  async biometricsEnabled(): Promise<boolean> {
    if (!this.host.platform.biometrics) return false;
    return this.host.prefs.get<boolean>(PREF.biometrics, false);
  }

  private putUnlocked(path: VaultPath, body: string, key: CryptoKey): void {
    const now = Date.now();
    this.patch({
      unlocked: {
        ...this.state.unlocked,
        [path]: { body, key, unlockedAt: now, lockAt: this.nextLockAt(now) },
      },
    });
    /* FLAG_SECURE: содержимое не попадает в превью задач (BEHAVIOR §5.3). */
    this.host.platform.secureFlag(true);
  }

  private nextLockAt(now: number): number {
    return this.autoLockMinutes === null
      ? Number.POSITIVE_INFINITY
      : now + this.autoLockMinutes * 60_000;
  }

  /** Любой ввод или скролл сбрасывает таймер автозамка (BEHAVIOR §5.3). */
  touchLock(path: VaultPath): void {
    const entry = this.state.unlocked[path];
    if (!entry) return;
    this.patch({
      unlocked: { ...this.state.unlocked, [path]: { ...entry, lockAt: this.nextLockAt(Date.now()) } },
    });
  }

  /** Немедленный замок: тап по замку, выход из заметки, сворачивание. */
  lockNote(path: VaultPath): void {
    const unlocked = { ...this.state.unlocked };
    delete unlocked[path];
    this.patch({ unlocked });
    if (Object.keys(unlocked).length === 0) this.host.platform.secureFlag(false);
  }

  /**
   * Замок закрывает ВСЁ, включая ключ хранилища.
   *
   * До иерархии ключей замок закрывал по заметке за раз, потому что и ключ был
   * у каждой свой. Теперь ключ один: оставить его в памяти после автозамка
   * значило бы, что запертая заметка открывается без пароля (BEHAVIOR §5.3).
   */
  lockAll(): void {
    this.master = null;
    this.patch({ unlocked: {} });
    this.host.platform.secureFlag(false);
  }

  setAutoLockMinutes(minutes: number | null): void {
    this.autoLockMinutes = minutes;
    this.persistPref(PREF.autoLock, minutes);
  }

  /** «Шифровать новые заметки» — настройка, а не намерение: переживает запуск. */
  async setEncryptNewNotes(on: boolean): Promise<void> {
    this.encryptNewNotes = on;
    await this.host.prefs.set(PREF.encryptNewNotes, on);
  }

  getEncryptNewNotes(): boolean {
    return this.encryptNewNotes;
  }

  getAutoLockMinutes(): number | null {
    return this.autoLockMinutes;
  }

  private startLockWatch(): void {
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = setInterval(() => {
      const now = Date.now();
      const unlocked = { ...this.state.unlocked };
      let changed = false;
      for (const [path, entry] of Object.entries(unlocked)) {
        if (entry.lockAt <= now) {
          delete unlocked[path];
          changed = true;
        }
      }
      if (changed) {
        this.patch({ unlocked });
        if (Object.keys(unlocked).length === 0) this.host.platform.secureFlag(false);
      }
    }, 1000);
  }

  /**
   * Снятие шифрования — одно из ТРЁХ мест с диалогом подтверждения.
   *
   * Пароль спрашивается и здесь, даже если хранилище открыто: это операция,
   * после которой заметка ложится на диск открытым текстом, и подтвердить её
   * должен человек, а не открытый сеанс.
   */
  async removeEncryption(path: VaultPath, password: string): Promise<VaultPath | null> {
    const vault = this.vault;
    if (!vault) return null;
    const header = await vault.storage.read(path);
    const parsed = header ? this.crypto.parseHeader(header) : null;
    if (!parsed) return null;
    const master =
      parsed.version === LEGACY_CONTAINER_VERSION
        ? await this.crypto.deriveMaster(password, (await this.vaultSalt()) ?? parsed.salt)
        : await this.crypto.deriveMaster(password, parsed.salt);
    const target = await decryptNoteToDisk(vault.storage, this.crypto, path, master, password);
    if (!target) return null;
    this.lockNote(path);
    await vault.rebuild();
    await this.refresh();
    return target;
  }

  // ── Синхронизация (BEHAVIOR §6) ────────────────────────────────────────────

  /**
   * Сменить место хранения бережно.
   *
   * Заказчик: «это должны быть взаимоисключающие вещи, но с бережностью при
   * переключении из одного режима в другой: данные не должны потеряться».
   *
   * Взаимоисключающими они и были: движок синхронизации ровно один, и
   * `attachBackend` заменяет предыдущий. Не хватало бережности — уход с
   * бэкенда обрывал всё, что ещё не ушло: автосинк идёт с задержкой 5 с
   * после правки, и переключение в эту секунду оставляло последнюю правку
   * только на устройстве. Заметки при этом не пропадали (они всегда лежат
   * локально), но на другом устройстве их не было, а человек считал, что
   * синхронизировал.
   *
   * Поэтому сначала досылаем, потом отключаем. Неудача досылки переключению
   * не мешает: она означает «сеть недоступна», а заметки от этого никуда не
   * денутся — они на диске.
   */
  async switchBackend(backend: SyncBackend | null): Promise<void> {
    if (this.engine) await this.syncNow().catch(() => undefined);
    this.attachBackend(backend);
  }

  attachBackend(backend: SyncBackend | null): void {
    const changed = backend?.id !== this.state.backendId;
    this.backend = backend;
    this.engine =
      backend && this.vault
        ? new SyncEngine(this.vault, backend, {
            /* Про сеть знает оболочка, а не движок: без этого «не дозвонились»
               объявлялось «оффлайном» даже там, где интернет заведомо есть. */
            isOnline: () => this.state.online,
            /* Очередь у приложения одна на хранилище: накопленное без облака
               обязано достаться движку, как только место появилось. */
            ...(this.changes ? { queue: this.changes } : {}),
          })
        : null;
    this.patch({
      backendId: backend?.id ?? null,
      backendChoice: backend?.id ?? null,
      cloudNeedsSignIn: false,
    });
    this.persistPref(PREF.backend, backend?.id ?? null);
    /*
     * Первый обмен с новым местом заканчивается тостом с числами.
     *
     * Подсказка в настройках обещает: накопленное уедет туда, тамошнее
     * приедет сюда, при расхождении сохранятся обе версии. Обещание надо
     * закрыть фактом — иначе человек нажал, что-то произошло, и проверять
     * ему приходится открыванием папки. Особенно это важно из-за копий
     * «(конфликт, …)»: увидеть их в списке без объяснения — та же паника,
     * что и от пропажи.
     */
    if (this.engine) void this.syncNow({ announce: changed });
  }

  /** Автосинк после сохранения — debounce 5 с (BEHAVIOR §6). */
  private scheduleSync(path: VaultPath): void {
    /* Отметка «не отправлено» ставится ВСЕГДА, даже когда отправлять некуда:
       без облака правка не перестаёт быть правкой. Раньше этот метод при
       отсутствии движка выходил первой строкой, и накопленное офлайн нигде не
       числилось. */
    void this.changes?.enqueue(path).then(() => this.patchPending());
    if (!this.engine) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, 5000);
  }

  /** Сколько изменений ждут отправки. Без хранилища — нисколько. */
  pendingCount(): number {
    return this.changes?.size ?? 0;
  }

  /** Показать в состоянии текущее число неотправленных. */
  private patchPending(): void {
    const pending = this.pendingCount();
    if (this.state.sync.pending === pending) return;
    this.patch({ sync: { ...this.state.sync, pending } });
  }

  /**
   * Возвращение к приложению: досылаем накопленное.
   *
   * Момент выбран не случайно. Телефон почти всё время спит, и события
   * `online` может не быть вовсе: сеть была в порядке, недоступно было
   * облако — или приложение просто свернули на сутки. Зато есть минута, когда
   * человек снова открыл ЗАПИСКИ, и обещание «накопленное уедет» пора
   * выполнять именно тогда, а не по нажатию «Синхронизировать сейчас».
   *
   * Впустую не ходим: без места и без очереди делать здесь нечего.
   */
  async resumeSync(): Promise<void> {
    if (!this.engine || this.pendingCount() === 0) return;
    await this.syncNow();
  }

  async syncNow(options: { announce?: boolean } = {}): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    if (!this.state.online) {
      /* Оффлайн — нормальный режим, а не сбой (SCREENS §10). */
      this.patch({ sync: { ...this.state.sync, state: 'offline' }, syncError: null });
      return;
    }
    this.patch({ sync: { ...this.state.sync, state: 'syncing' } });
    try {
      const outcome = await engine.sync();
      this.patch({ sync: outcome, syncError: outcome.error ?? null });
      for (const message of outcome.messages) this.toast({ message });
      if (options.announce === true && outcome.error === undefined) {
        this.toast({
          message: this.strings.settings.sync.firstSyncSummary(
            outcome.pushed,
            outcome.pulled,
            outcome.conflicts,
          ),
        });
      }
      await this.refresh();
    } catch {
      /* Сетевые ошибки — только в статусе синка, не модалками (BEHAVIOR §0). */
      this.reportError(this.strings.errors.syncFailed);
    }
  }

  setOnline(online: boolean): void {
    this.patch({
      online,
      sync: {
        ...this.state.sync,
        state: online ? this.state.sync.state : 'offline',
      },
      syncError: online ? this.state.syncError : null,
    });
    if (online) void this.syncNow();
  }

  /** Ошибка живёт в статусе. Ввод текста она не трогает (приёмочный критерий №5). */
  reportError(message: string): void {
    this.patch({
      syncError: message,
      sync: { ...this.state.sync, state: 'error', error: message },
    });
  }

  clearError(): void {
    this.patch({ syncError: null, sync: { ...this.state.sync, state: 'synced' } });
  }

  // ── Экспорт (BEHAVIOR §9) ──────────────────────────────────────────────────

  /**
   * Одна заметка в выбранном формате. PDF всегда светлая «Бумага», колонка 640
   * и без интерфейсных элементов — за это отвечает `PDF_PAGE_SETUP` ядра.
   *
   * Зашифрованная заметка экспортируется только после разблокировки: тело
   * берётся из `readNote`, а он отдаёт текст лишь для открытой заметки.
   */
  async exportNoteAs(path: VaultPath, format: 'md' | 'html' | 'docx' | 'pdf'): Promise<void> {
    const note = await this.readNote(path);
    if (!note) return;
    if (note.encrypted && !this.isUnlocked(path)) return;
    if (format === 'pdf') {
      const renderer = this.host.pdf;
      if (!renderer) return;
      const data = await exportPdf(note, renderer);
      /* Веб печатает средствами браузера и байтов не отдаёт: файл уже у
         пользователя, сохранять нечего. */
      if (data.byteLength > 0) {
        await this.host.saveFile(`${note.title || stemOf(path)}.pdf`, data, 'application/pdf');
      }
      return;
    }
    const file = exportNote(note, format);
    await this.host.saveFile(file.name, file.data, MIME[format]);
  }

  /** Все заметки — zip со структурой папок и `attachments`. */
  async exportAll(): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const paths = this.state.notes.filter((note) => !note.encrypted).map((note) => note.path);
    const data = await exportArchive(vault, paths);
    await this.host.saveFile('zapiski.zip', data, 'application/zip');
  }

  // ── Аккаунт ────────────────────────────────────────────────────────────────

  setAccount(account: AccountState | null): void {
    this.patch({ account });
    this.persistPref(PREF.account, account);
  }

  // ── Отладочное меню (приёмочный критерий №10) ──────────────────────────────

  setDebug(patch: Partial<DebugOverrides>): void {
    this.patch({ debug: { ...this.state.debug, ...patch } });
  }

  /**
   * Эффективное состояние экрана: принудительное из отладочного меню, иначе —
   * вычисленное из данных. Порядок важен: `locked` сильнее `empty`.
   */
  screenState(screen: MatrixScreen, isEmpty: boolean): ScreenState {
    const forced = this.state.debug.forceState;
    if (forced) {
      if (forced === 'normal') return 'normal';
      return MATRIX[screen][forced] ? forced : 'normal';
    }
    if (this.state.booting) return 'loading';
    if (this.state.syncError && MATRIX[screen].error) return 'error';
    if (!this.state.online && MATRIX[screen].offline) return 'offline';
    if (isEmpty && MATRIX[screen].empty) return 'empty';
    return 'normal';
  }

  setLocale(locale: Locale): void {
    this.patch({ locale });
    this.persistPref(PREF.locale, locale);
  }
}

/** Путь папки, в которой лежит заметка. */
function folderOf(path: VaultPath): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Текст ошибки записи — строго из реестра BEHAVIOR §11. */
function diskErrorMessage(error: unknown, strings: Strings): string {
  const text = String((error as { name?: string; message?: string })?.name ?? error ?? '');
  if (/quota|space|ENOSPC/i.test(text)) return strings.errors.noSpace;
  if (/NotAllowed|NotFound|permission/i.test(text)) return strings.errors.folderUnavailable;
  return strings.errors.fileCorrupted;
}

/**
 * Перезапись зашифрованной заметки: сначала контейнер, потом — ничего больше.
 * Открытый текст на диск не попадает (ТЗ §3.3).
 */
async function encryptNoteFileSafely(
  vault: Vault,
  crypto: WebCryptoProvider,
  path: VaultPath,
  body: string,
  key: CryptoKey,
): Promise<void> {
  const container = await crypto.encrypt(body, key);
  await vault.storage.write(encryptedPathOf(path), container);
}

export { isEncryptedPath, stemOf, countWords };
