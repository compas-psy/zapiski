/**
 * Состояние приложения и все действия над ним.
 *
 * Здесь нет ни одной платформенной детали: всё, что нужно от устройства,
 * приходит через `AppHost` (contract.ts). Поэтому один и тот же контроллер
 * работает в вебе, на Windows и на Android (ARCHITECTURE §1).
 */
import {
  MemoryVaultStorage,
  SyncEngine,
  Vault,
  WebCryptoProvider,
  countWords,
  decryptNoteFile,
  decryptNoteToDisk,
  encryptNoteFile,
  encryptedPathOf,
  isEncryptedPath,
  parseQuery,
  passwordHint,
  stemOf,
  unlockDelayMs,
  type FolderNode,
  type Note,
  type NoteMeta,
  type SearchHit,
  type SyncBackend,
  type SyncStatus,
  type TrashEntry,
  type UndoableToast,
  type VaultPath,
  type VaultStorage,
} from '@zapiski/core';
import type {
  AppHost,
  DebugOverrides,
  Route,
  ScreenState,
  SettingsSection,
} from '../contract.js';
import { strings as buildStrings, DEFAULT_LOCALE, type Locale, type Strings } from '../i18n/index.js';

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
  online: boolean;

  libraryOpen: boolean;
  paletteOpen: boolean;
  infoOpen: boolean;
  focusMode: boolean;
  rawMode: boolean;
  debugOpen: boolean;
  shareOpen: boolean;

  account: AccountState | null;

  /** Пути с открытым (расшифрованным) содержимым. */
  unlocked: Record<VaultPath, UnlockedNote>;
  /** Неудачные попытки пароля — задержки BEHAVIOR §5.2. */
  failedAttempts: number;
  /** До какого момента ввод пароля отклоняется. Данные не удаляются никогда. */
  lockedUntil: number;

  debug: DebugOverrides;

  /**
   * Последняя ошибка для статуса синка. НИКОГДА не превращается в модалку и
   * не блокирует ввод (BEHAVIOR §0, приёмочный критерий №5).
   */
  syncError: string | null;
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
    online: true,
    libraryOpen: false,
    paletteOpen: false,
    infoOpen: false,
    focusMode: false,
    rawMode: false,
    debugOpen: false,
    shareOpen: false,
    account: null,
    unlocked: {},
    failedAttempts: 0,
    lockedUntil: 0,
    debug: { forceState: null, forceSyncBackend: null },
    syncError: null,
  };
}

export interface ToastRequest {
  message: string;
  actionLabel?: string | undefined;
  onAction?: (() => void | Promise<void>) | undefined;
}

/** Ключи в `PreferencesStore` (настройки вне vault'а). */
const PREF = {
  locale: 'locale',
  sort: 'list.sort',
  recent: 'search.recent',
  lastOpened: 'search.lastOpened',
  backend: 'sync.backend',
  autoLock: 'security.autoLockMinutes',
  account: 'account',
  onboarded: 'onboarded',
} as const;

export class AppController {
  private state: AppState;
  private readonly listeners = new Set<Listener>();
  private vault: Vault | null = null;
  private engine: SyncEngine | null = null;
  private backend: SyncBackend | null = null;
  private readonly crypto = new WebCryptoProvider();
  /** Автозамок: единственный таймер на всё приложение (BEHAVIOR §5.3). */
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private renameTimer: ReturnType<typeof setInterval> | null = null;
  /** Минут до автозамка; `null` — до выхода из приложения. */
  private autoLockMinutes: number | null = 10;

  constructor(
    readonly host: AppHost,
    /** Куда уходят ОО-тосты (BEHAVIOR §0). Провайдер подставляет `useToast`. */
    private toastSink: (toast: ToastRequest) => void = () => {},
    locale: Locale = DEFAULT_LOCALE,
  ) {
    this.state = initialState(locale);
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

  async boot(): Promise<void> {
    const [sortByFolder, recentQueries, lastOpened, account, autoLock, onboarded] =
      await Promise.all([
        this.host.prefs.get<Record<string, SortMode>>(PREF.sort, {}),
        this.host.prefs.get<string[]>(PREF.recent, []),
        this.host.prefs.get<VaultPath[]>(PREF.lastOpened, []),
        this.host.prefs.get<AccountState | null>(PREF.account, null),
        this.host.prefs.get<number | null>(PREF.autoLock, 10),
        this.host.prefs.get<boolean>(PREF.onboarded, false),
      ]);
    this.autoLockMinutes = autoLock;
    this.patch({ sortByFolder, recentQueries, lastOpened, account });

    const storage = await this.host.restoreVault().catch(() => null);
    if (!storage || !onboarded) {
      /* Нет хранилища — онбординг с выбором места (SCREENS §1, шаг 2). */
      this.patch({ booting: false, route: { name: 'onboarding', step: 1 } });
      return;
    }
    await this.openVault(storage);
  }

  /** Открыть vault поверх готового хранилища и перейти к списку. */
  async openVault(storage: VaultStorage): Promise<void> {
    this.patch({ booting: true });
    const vault = await Vault.open(storage, { locale: this.state.locale });
    this.vault = vault;
    vault.onChange(() => {
      void this.refresh();
    });
    /* Отложенные переименования файла по заголовку — 2 с (BEHAVIOR §2.2). */
    this.renameTimer = setInterval(() => {
      void vault.flushRenames().then((results) => {
        const updated = results.reduce((sum, result) => sum + result.updatedLinks, 0);
        if (updated > 0) this.toast({ message: this.strings.errors.linksUpdated(updated) });
      });
    }, 1000);
    this.startLockWatch();
    await this.refresh();
    this.patch({ ready: true, booting: false, route: { name: 'list' } });
    await this.host.prefs.set(PREF.onboarded, true);
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
  }

  // ── Данные ─────────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const folders = await vault.folders();
    this.patch({
      notes: vault.notes(),
      folders,
      tags: vault.index.tagFrequencies(),
      trash: vault.listTrash(),
      sync: this.engine ? this.engine.status() : this.state.sync,
    });
  }

  get vaultRef(): Vault | null {
    return this.vault;
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

  navigate(route: Route, options: { replace?: boolean } = {}): void {
    const stack = options.replace ? this.state.stack : [...this.state.stack, this.state.route];
    this.patch({ route, stack: stack.slice(-20), libraryOpen: false, paletteOpen: false });
  }

  back(): void {
    const stack = [...this.state.stack];
    const previous = stack.pop();
    this.patch({ route: previous ?? { name: 'list' }, stack, infoOpen: false });
  }

  openNote(path: VaultPath): void {
    const lastOpened = [path, ...this.state.lastOpened.filter((item) => item !== path)].slice(0, 5);
    this.patch({ lastOpened });
    void this.host.prefs.set(PREF.lastOpened, lastOpened);
    this.navigate({ name: 'note', id: path });
  }

  openFolder(folder: string | null): void {
    this.patch({ folder, tag: null, scope: 'all' });
    this.navigate(folder ? { name: 'list', folder } : { name: 'list' });
  }

  openTag(tag: string): void {
    this.patch({ tag, folder: null, scope: 'all' });
    this.navigate({ name: 'list', tag });
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

  async createNote(folder?: string): Promise<VaultPath | null> {
    const vault = this.vault;
    if (!vault) return null;
    const note = await vault.create(folder ? { folder } : {});
    await this.refresh();
    this.openNote(note.path);
    return note.path;
  }

  /**
   * Автосохранение (BEHAVIOR §0): вызывается редактором по debounce 500 мс и
   * на blur. Слова «Сохранить» в UI нет — кнопки, вызывающей это, не существует.
   */
  async save(path: VaultPath, body: string): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const unlocked = this.state.unlocked[path];
    if (unlocked) {
      /* Зашифрованная заметка: открытый текст на диск не попадает никогда. */
      this.patch({
        unlocked: { ...this.state.unlocked, [path]: { ...unlocked, body } },
      });
      await encryptNoteFileSafely(vault, this.crypto, path, body, unlocked.key);
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
    await this.refresh();
    if (result.updatedLinks > 0) {
      this.toast({ message: this.strings.errors.linksUpdated(result.updatedLinks) });
    }
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
    void this.host.prefs.set(PREF.recent, recentQueries);
  }

  // ── Сортировка (BEHAVIOR §1.2 — на папку) ──────────────────────────────────

  sortModeFor(folder: string | null): SortMode {
    return this.state.sortByFolder[folder ?? ''] ?? 'updated';
  }

  setSortMode(folder: string | null, mode: SortMode): void {
    const sortByFolder = { ...this.state.sortByFolder, [folder ?? '']: mode };
    this.patch({ sortByFolder });
    void this.host.prefs.set(PREF.sort, sortByFolder);
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

  /** Задержка после неудачных попыток: 1–4 без задержки, 5-я — 30 с, 8-я — 5 мин. */
  get unlockDelayLeftMs(): number {
    return Math.max(0, this.state.lockedUntil - Date.now());
  }

  async encryptNote(
    path: VaultPath,
    password: string,
    hint?: string,
  ): Promise<VaultPath | null> {
    const vault = this.vault;
    if (!vault) return null;
    const salt = this.crypto.randomSalt();
    const key = await this.crypto.deriveMasterKey(password, salt);
    const target = await encryptNoteFile(vault.storage, this.crypto, path, key, hint);
    await vault.rebuild();
    await this.refresh();
    const body = (await decryptNoteFile(vault.storage, this.crypto, target, key)) ?? '';
    this.putUnlocked(target, body, key);
    if (this.state.route.name === 'note' && this.state.route.id === path) {
      this.navigate({ name: 'note', id: target }, { replace: true });
    }
    return target;
  }

  /**
   * Разблокировка паролем. `null` — пароль не подошёл: точки возвращаются,
   * подпись «Пароль не подошёл», данные не удаляются никогда.
   */
  async unlock(path: VaultPath, password: string): Promise<string | null> {
    const vault = this.vault;
    if (!vault) return null;
    if (this.unlockDelayLeftMs > 0) return null;
    const header = await vault.storage.read(path);
    const parsed = header ? this.crypto.parseHeader(header) : null;
    if (!parsed) return null;
    const key = await this.crypto.deriveMasterKey(password, parsed.salt);
    const body = await decryptNoteFile(vault.storage, this.crypto, path, key);
    if (body === null) {
      const failedAttempts = this.state.failedAttempts + 1;
      const delay = unlockDelayMs(failedAttempts);
      this.patch({ failedAttempts, lockedUntil: delay > 0 ? Date.now() + delay : 0 });
      return null;
    }
    this.patch({ failedAttempts: 0, lockedUntil: 0 });
    this.putUnlocked(path, body, key);
    this.host.platform.haptics?.impact('light');
    return body;
  }

  /** Разблокировка биометрией. Отмена пользователем — не ошибка (BEHAVIOR §5.2). */
  async unlockWithBiometrics(path: VaultPath): Promise<string | null> {
    const biometrics = this.host.platform.biometrics;
    const vault = this.vault;
    if (!biometrics || !vault) return null;
    const secret = await biometrics.unlock(path).catch(() => null);
    if (!secret) return null;
    return this.unlock(path, new TextDecoder().decode(secret));
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

  lockAll(): void {
    this.patch({ unlocked: {} });
    this.host.platform.secureFlag(false);
  }

  setAutoLockMinutes(minutes: number | null): void {
    this.autoLockMinutes = minutes;
    void this.host.prefs.set(PREF.autoLock, minutes);
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

  /** Снятие шифрования — одно из ТРЁХ мест с диалогом подтверждения. */
  async removeEncryption(path: VaultPath, password: string): Promise<VaultPath | null> {
    const vault = this.vault;
    if (!vault) return null;
    const header = await vault.storage.read(path);
    const parsed = header ? this.crypto.parseHeader(header) : null;
    if (!parsed) return null;
    const key = await this.crypto.deriveMasterKey(password, parsed.salt);
    const target = await decryptNoteToDisk(vault.storage, this.crypto, path, key);
    if (!target) return null;
    this.lockNote(path);
    await vault.rebuild();
    await this.refresh();
    return target;
  }

  // ── Синхронизация (BEHAVIOR §6) ────────────────────────────────────────────

  attachBackend(backend: SyncBackend | null): void {
    this.backend = backend;
    this.engine = backend && this.vault ? new SyncEngine(this.vault, backend) : null;
    this.patch({ backendId: backend?.id ?? null });
    void this.host.prefs.set(PREF.backend, backend?.id ?? null);
    if (this.engine) void this.syncNow();
  }

  /** Автосинк после сохранения — debounce 5 с (BEHAVIOR §6). */
  private scheduleSync(path: VaultPath): void {
    const engine = this.engine;
    if (!engine) return;
    void engine.markChanged(path);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, 5000);
  }

  async syncNow(): Promise<void> {
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

  // ── Аккаунт ────────────────────────────────────────────────────────────────

  setAccount(account: AccountState | null): void {
    this.patch({ account });
    void this.host.prefs.set(PREF.account, account);
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
    void this.host.prefs.set(PREF.locale, locale);
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
