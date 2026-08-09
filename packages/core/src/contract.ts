/**
 * Контракт ядра КОМПАС.ЗАПИСКИ.
 *
 * Этот файл — единственный источник правды по типам домена и платформенным
 * портам. Его импортируют ядро, редактор, экраны и сервер. Менять его можно
 * только согласованно: изменение здесь ломает компиляцию во всех пакетах —
 * это сделано намеренно (docs/ARCHITECTURE.md §5).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Домен
// ─────────────────────────────────────────────────────────────────────────────

/** Стабильный идентификатор заметки. Живёт во frontmatter либо в индексе. */
export type NoteId = string;

/** Путь внутри vault'а, всегда с прямыми слэшами и без ведущего слэша. */
export type VaultPath = string;

export interface NoteMeta {
  id: NoteId;
  /** Путь к файлу относительно корня vault'а: `Проекты/Идея.md` */
  path: VaultPath;
  /** Заголовок = первая строка файла (BEHAVIOR §2.2). */
  title: string;
  /** Первые ~200 символов тела без разметки — для строки списка. */
  snippet: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** Вложенные теги целиком: `практика/супервизия`. */
  tags: string[];
  /** Заметка зашифрована (`.md.enc`). Тело и заголовок НЕ индексируются. */
  encrypted: boolean;
  /** Есть ли вложения / ссылки / чекбоксы — для оператора `has:`. */
  hasImage: boolean;
  hasFile: boolean;
  hasTodo: boolean;
  hasLink: boolean;
  wordCount: number;
  /** Порядок для ручной сортировки закреплённых (BEHAVIOR §1.2). */
  pinOrder?: number;
}

export interface Note extends NoteMeta {
  /** Полный markdown-текст. Для зашифрованной — только после разблокировки. */
  body: string;
}

export interface VaultEntry {
  path: VaultPath;
  name: string;
  isDirectory: boolean;
}

export interface VaultStat {
  size: number;
  mtime: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Платформенные порты — единственное, чем различаются web / Windows / Android
// ─────────────────────────────────────────────────────────────────────────────

export interface VaultStorage {
  read(path: VaultPath): Promise<Uint8Array | null>;
  /** Обязана быть атомарной: запись во временный файл + rename (ТЗ §4.3). */
  write(path: VaultPath, data: Uint8Array): Promise<void>;
  remove(path: VaultPath): Promise<void>;
  rename(from: VaultPath, to: VaultPath): Promise<void>;
  list(dir: VaultPath): Promise<VaultEntry[]>;
  stat(path: VaultPath): Promise<VaultStat | null>;
  mkdir(dir: VaultPath): Promise<void>;
}

export interface BiometricProvider {
  /** true, если на устройстве есть настроенная биометрия. */
  isAvailable(): Promise<boolean>;
  /** Кладёт ключ в Android Keystore / Windows Hello / WebAuthn-PRF. */
  enroll(keyId: string, secret: Uint8Array): Promise<void>;
  /** Возвращает секрет после успешной биометрии, либо null при отмене. */
  unlock(keyId: string): Promise<Uint8Array | null>;
  remove(keyId: string): Promise<void>;
}

export type HapticStrength = 'light' | 'medium';

export interface HapticProvider {
  impact(strength: HapticStrength): void;
}

export interface GlobalHotkeyProvider {
  register(accelerator: string, handler: () => void): Promise<void>;
  unregister(accelerator: string): Promise<void>;
}

export interface SharedPayload {
  kind: 'text' | 'link' | 'image';
  text?: string;
  url?: string;
  bytes?: Uint8Array;
  mime?: string;
}

export interface ShareTargetProvider {
  /** Вызывается, когда ОС передала контент в приложение (BEHAVIOR §8). */
  onShare(handler: (payload: SharedPayload) => void): () => void;
}

export interface UpdateInfo {
  version: string;
  notes: string;
  pubDate: string;
  url: string;
}

export interface UpdaterProvider {
  check(): Promise<UpdateInfo | null>;
  downloadAndInstall(onProgress?: (fraction: number) => void): Promise<void>;
}

export interface PlatformCapabilities {
  /** `web` | `windows` | `android` — только для телеметрии и мелких различий. */
  readonly kind: 'web' | 'windows' | 'android';
  readonly biometrics: BiometricProvider | null;
  readonly haptics: HapticProvider | null;
  readonly globalHotkey: GlobalHotkeyProvider | null;
  readonly shareTarget: ShareTargetProvider | null;
  readonly updater: UpdaterProvider | null;
  /** FLAG_SECURE: скрыть содержимое в превью задач ОС (BEHAVIOR §5.3). */
  secureFlag(on: boolean): void;
  /** Открыть системный диалог выбора папки vault'а. */
  pickVaultDirectory(): Promise<VaultStorage | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Поиск (BEHAVIOR §4)
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchFilters {
  tag?: string[];
  folder?: string[];
  before?: number;
  after?: number;
  has?: Array<'image' | 'file' | 'todo' | 'link'>;
  /** Термы в кавычках — искать как точную фразу. */
  phrases?: string[];
  /** Термы с минусом — исключить. */
  exclude?: string[];
}

export interface SearchQuery {
  text: string;
  filters: SearchFilters;
}

export interface SearchFragment {
  /** Текст фрагмента с контекстом ±40 символов. */
  text: string;
  /** Диапазоны совпадений внутри `text` — для подсветки. */
  ranges: Array<[start: number, end: number]>;
}

export interface SearchHit {
  note: NoteMeta;
  score: number;
  /** До 3 фрагментов (BEHAVIOR §4). Пусто у зашифрованных. */
  fragments: SearchFragment[];
  /** Заметка зашифрована: «содержимое не ищется». */
  encryptedPlaceholder: boolean;
}

export interface NoteIndex {
  add(note: Note): void;
  update(note: Note): void;
  remove(id: NoteId): void;
  search(query: SearchQuery, limit?: number): SearchHit[];
  /** Кто ссылается на эту заметку — `[[wiki]]` и markdown-ссылки. */
  backlinks(id: NoteId): NoteMeta[];
  all(): NoteMeta[];
  byTag(tag: string): NoteMeta[];
  byFolder(folder: VaultPath): NoteMeta[];
  /** Полная перестройка из файлов — индекс всегда производная (ТЗ §2.1.1). */
  rebuild(notes: Note[]): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Крипто (ТЗ §3.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface EncryptedContainer {
  /** Магия формата: `ZPSK`. */
  magic: string;
  version: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** Подсказка к паролю, если задана. Хранится открытым текстом намеренно. */
  hint?: string;
}

export interface CryptoProvider {
  /** Argon2id по RFC 9106. */
  deriveMasterKey(password: string, salt: Uint8Array): Promise<CryptoKey>;
  encrypt(plaintext: string, key: CryptoKey, hint?: string): Promise<Uint8Array>;
  /** null — пароль не подошёл (BEHAVIOR §5.2, без исключений в UI). */
  decrypt(container: Uint8Array, key: CryptoKey): Promise<string | null>;
  parseHeader(container: Uint8Array): Pick<EncryptedContainer, 'version' | 'salt' | 'hint'> | null;
  randomSalt(): Uint8Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Синхронизация (ТЗ §4)
// ─────────────────────────────────────────────────────────────────────────────

export type SyncState = 'synced' | 'syncing' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  lastSyncAt: number | null;
  noteCount: number;
  bytes: number;
  /** Текст из реестра BEHAVIOR §11, если state === 'error'. */
  error?: string;
}

export interface RemoteEntry {
  path: VaultPath;
  etag: string;
  mtime: number;
  size: number;
}

/** Общий интерфейс для LocalFolder / WebDAV / ЯндексДиск / KompasCloud. */
export interface SyncBackend {
  readonly id: 'local' | 'webdav' | 'yandex' | 'kompas';
  readonly title: string;
  list(): Promise<RemoteEntry[]>;
  get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null>;
  put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }>;
  remove(path: VaultPath): Promise<void>;
  /** Мгновенный синк там, где он есть (websocket у KompasCloud). */
  subscribe?(onChange: (path: VaultPath) => void): () => void;
}

export interface VersionSnapshot {
  id: string;
  noteId: NoteId;
  takenAt: number;
  /** Откуда пришла версия: имя устройства или 'local'. */
  source: string;
  /** Помечена ли версия как результат автослияния (SCREENS §10b `4h`). */
  merged: boolean;
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Уведомления UI (BEHAVIOR §0: ОО-тосты)
// ─────────────────────────────────────────────────────────────────────────────

export interface UndoableToast {
  /** Текст строго из реестра BEHAVIOR §11. */
  message: string;
  /** Живёт 6 секунд. */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}
