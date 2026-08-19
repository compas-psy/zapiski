/**
 * Контракт ядра ЗАПИСКИ.
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
  /** Заголовок = первая строка файла вида `# Название` (ITERATION-1 §1). */
  title: string;
  /**
   * У заметки нет заголовка: файл начинается не с H1. В `title` при этом
   * подставлено «Без названия», чтобы не заводить пустую строку по всему
   * приложению, а флаг нужен списку — такой заголовок печатается приглушённым
   * цветом (ITERATION-1 §1). Отличать по совпадению строки нельзя: заметку
   * могут озаглавить ровно так же.
   */
  untitled?: boolean;
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

/**
 * Что умеет место, выбранное под vault.
 *
 * Появилось из-за Android: системный выбор папки отдаёт дерево `content://`
 * (SAF), в котором переименование бывает не у всех провайдеров, а без
 * переименования нет и атомарной записи ТЗ §4.3. Скрывать это от пользователя
 * нельзя, поэтому свойство места едет вместе с самим местом.
 */
export type VaultWriteMode =
  /** Временный файл + rename поверх существующего — инвариант ТЗ §4.3 выполнен. */
  | 'atomic'
  /**
   * Временный документ, затем замена в два шага. Так умеет SAF-провайдер с
   * поддержкой переименования: длинная часть записи безопасна, окно риска —
   * доли секунды между удалением старого документа и переименованием нового.
   */
  | 'staged'
  /** Запись прямо в документ: сбой питания посреди неё оставит его неполным. */
  | 'direct';

export interface VaultLocationInfo {
  /** `app` — каталог приложения (умолчание), `user` — папка пользователя. */
  kind: 'app' | 'user';
  /** Чего стоит ждать от записи в это место (ТЗ §4.3). */
  writeMode: VaultWriteMode;
  /** Человекочитаемое имя места — для настроек и онбординга. */
  label: string;
  /**
   * Настоящий адрес места: путь на диске или `content://` дерева SAF.
   *
   * Заведено не для красоты. Три круга подряд заказчик видел в настройках имя
   * каталога приложения там, где он только что указал свою папку, и по имени
   * нельзя было понять НИ ЧТО открыто на самом деле, ни почему выбор не
   * применился. Имя — вывод приложения о месте; адрес — само место. Когда они
   * расходятся, видно должно быть оба.
   */
  detail?: string;
}

export interface VaultLocation extends VaultLocationInfo {
  storage: VaultStorage;
}

/**
 * Чьё хранилище открыто: `'local'` — без аккаунта, иначе почта учётки.
 *
 * Модель та же, что у Obsidian: хранилище — это папка, которую выбрал человек,
 * а смена личности означает смену хранилища, а не подмешивание чужих файлов в
 * открытую папку.
 */
export type VaultOwner = string;

/** Хозяин без аккаунта — локальная работа. */
export const LOCAL_OWNER: VaultOwner = 'local';

/** Ключ владельца из почты: регистр и пробелы не должны заводить два места. */
export function ownerKeyOf(email: string | null | undefined): VaultOwner {
  const trimmed = (email ?? '').trim().toLowerCase();
  return trimmed === '' ? LOCAL_OWNER : trimmed;
}

/**
 * Выбор папки там, где он существует, но идёт с оговорками.
 *
 * Порт необязательный: на Windows и в вебе выбранная пользователем папка ничем
 * не хуже умолчания, и разделять их незачем — там есть `pickVaultDirectory`.
 * На Android разница настоящая, и решение о ней принимает пользователь
 * (ТЗ §4.1 п. 1: LocalFolder — в том числе папка, которую синкает сторонний
 * клиент), а не мы за него.
 */
/**
 * Владелец обязателен во всех трёх методах — по той же причине, что и в
 * `pickVaultDirectory`. Порт был owner-blind, и это стоило заказчику дня:
 * `current()` — вопрос «где папка» — по дороге ЗАНИМАЛ старую папку за
 * `local`, потому что владельца ему не передавали. Дальше учётка получала
 * пустую подпапку, синхронизация уносила в облако пустоту, а человек читал это
 * как «не могу синхронизироваться».
 */
export interface VaultFolderPicker {
  /** Системный выбор папки. `null` — пользователь отменил выбор. */
  chooseFolder(owner?: VaultOwner): Promise<VaultLocation | null>;
  /** Вернуться к каталогу приложения — надёжный путь с атомарной записью. */
  useAppFolder(owner?: VaultOwner): Promise<VaultLocation | null>;
  /**
   * Где заметки лежат сейчас. `null` — место ещё не выбрано.
   *
   * Это ВОПРОС. Он обязан быть чистым: ни одной записи в настройки, ни одной
   * заявки на папку. Экран настроек зовёт его на каждую перерисовку.
   */
  current(owner?: VaultOwner): Promise<VaultLocationInfo | null>;
}

/**
 * Системное «Поделиться».
 *
 * Исходов три, и путать их нельзя. Первая версия возвращала `Boolean`, и на
 * устройстве заказчика это дало тост «ни одно приложение не принимает текст»
 * там, где приложений полно: настоящая причина стиралась на месте, и починить
 * по такому отчёту было нечего. Теперь неудача несёт с собой слова системы, а
 * запасной путь (буфер обмена) называется своим именем.
 *
 * Отмена человеком отказом НЕ считается: закрыть чужое окно — его право, и
 * извиняться за это приложению не за что.
 */
/** Чем закончилась попытка отдать заметку. */
export type ShareOutcome =
  /** Системное окно открылось — дальше решает человек. */
  | { kind: 'shared' }
  /** Окна не случилось, текст лёг в буфер обмена: вставить можно куда угодно. */
  | { kind: 'copied' }
  /** Не вышло ничего. `reason` — то, что ответила система, без нашей трактовки. */
  | { kind: 'failed'; reason?: string };

/**
 * Файл, который уезжает вместе с заметкой.
 *
 * Байты, а не путь: порт не знает ни про SAF, ни про приватный каталог, а
 * прочитать вложение умеет само приложение — тем же способом, каким показывает
 * его на экране. Платформа кладёт байты туда, откуда их заберёт получатель.
 */
export interface ShareOutFile {
  /** Имя, под которым файл увидит получатель. Без путей и слэшей. */
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ShareOutProvider {
  /**
   * Отдать заметку системному «Поделиться».
   *
   * `files` — вложения заметки (сейчас картинки). Их отсутствие отказом не
   * является: заметка уезжает текстом, как и раньше.
   */
  share(payload: {
    title?: string;
    text: string;
    files?: readonly ShareOutFile[];
  }): Promise<ShareOutcome>;
}

export interface PlatformCapabilities {
  /**
   * Где мы работаем: `web` | `windows` | `macos` | `android`.
   *
   * Оболочка настольного приложения ОДНА на Windows и macOS — решение
   * учредителя от 19.08.2026: один код на все платформы, без флагов сборки,
   * вырезающих функциональность. Значит `kind` определяется в рантайме, а не
   * захардкожен в оболочке: соврав здесь, приложение соврёт и серверу — от
   * этого поля зависит, куда возвращать человека после входа по ссылке.
   */
  readonly kind: 'web' | 'windows' | 'macos' | 'android';
  /**
   * Версия сборки — та, что видит человек в «О приложении» и называет в
   * письме поддержке. Приходит от оболочки, потому что версий три: у веба,
   * установщика Windows и apk свои номера, и подставлять сюда версию пакета
   * значило бы показывать не то, что установлено.
   */
  readonly version: string;
  readonly biometrics: BiometricProvider | null;
  readonly haptics: HapticProvider | null;
  readonly globalHotkey: GlobalHotkeyProvider | null;
  readonly shareTarget: ShareTargetProvider | null;
  /**
   * Отдать заметку системе — «Поделиться» (Android).
   *
   * Порт необязателен, и это не формальность: системного окна «Поделиться»
   * нет ни в Windows-оболочке, ни в вебе, где обмен идёт другими путями.
   * Экран проверяет наличие порта и без него кнопку не рисует вовсе — по
   * правилу BEHAVIOR §5.1 «скрытый элемент честнее выключенного».
   *
   * Наружу уходит текст, переведённый в разметку получателя
   * (`markdown/messenger.ts`), и картинки заметки отдельными файлами. Сырой
   * markdown отправлять бесполезно: `# Заголовок`, `> цитата`, `- пункт` и
   * `[имя](адрес)` не значат для мессенджера ничего, и заказчик увидел их в
   * Telegram именно так — текстом.
   */
  readonly shareOut?: ShareOutProvider | null;
  readonly updater: UpdaterProvider | null;
  /** FLAG_SECURE: скрыть содержимое в превью задач ОС (BEHAVIOR §5.3). */
  secureFlag(on: boolean): void;
  /**
   * Открыть системный диалог выбора папки vault'а.
   *
   * `owner` — чьё это хранилище: `'local'` без аккаунта, иначе почта учётки.
   * Оболочка запоминает выбор ОТДЕЛЬНО для каждого владельца, иначе вход
   * второй учёткой цепляет облако к чужой папке: заметки первой уезжают в
   * чужое облако при первой же синхронизации, а на экране два человека
   * оказываются перемешаны.
   */
  pickVaultDirectory(owner?: VaultOwner): Promise<VaultStorage | null>;
  /**
   * Выбор папки с оговорками (Android/SAF). Поле необязательное: платформа,
   * которой нечего оговаривать, его не реализует, и UI тогда не показывает
   * ни выбора, ни предупреждения — скрытый элемент честнее выключенного
   * (BEHAVIOR §5.1).
   */
  readonly vaultFolders?: VaultFolderPicker | null;
  /**
   * Управление окном — только там, где строку заголовка рисуем мы сами
   * (ITERATION-1 §6). `null` у веба и Android: у первого окна нет, у второго
   * его ведёт система. Экран проверяет наличие порта и без него полосу не
   * рисует вовсе — по тому же правилу §5.1.
   */
  readonly window?: WindowControls | null;
}

/**
 * Кнопки своей строки заголовка. Держатся портом, а не вызовом Tauri из
 * экрана: `packages/app` не знает, в какой оболочке он запущен, и знать не
 * должен (ARCHITECTURE §1).
 */
export interface WindowControls {
  /**
   * Кто рисует кнопки окна.
   *
   *  · `custom` — рисуем мы: окно без системных рамок, кнопки свои
   *    (Windows, ITERATION-1 §6);
   *  · `native-overlay` — рисует система: полосы заголовка нет, но три
   *    кнопки слева на месте (macOS, `titleBarStyle: Overlay`). Своих кнопок
   *    там быть не должно — получилось бы два комплекта, — а слева нужен
   *    отступ, чтобы содержимое не уезжало под «светофор».
   *
   * Спрашивается у оболочки, а не выводится из `platform.kind`: это свойство
   * ОКНА, и меняется оно вместе с конфигурацией окна, а не с системой.
   */
  readonly chrome: 'custom' | 'native-overlay';
  /** Ширина, которую занимает системный «светофор». `0` — его нет. */
  readonly inlineStartInset: number;
  minimize(): Promise<void>;
  /** Развернуть ↔ вернуть прежний размер. Двойной клик по полосе делает то же. */
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  /** Развёрнуто ли окно сейчас — от этого зависит иконка средней кнопки. */
  isMaximized(): Promise<boolean>;
  /** Подписка на смену размера: окно разворачивают и мышью за край экрана. */
  onMaximizeChange(handler: (maximized: boolean) => void): () => void;
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
  /** Идентификатор ключа заметки (версия 2). Случайные байты, не путь. */
  keyId?: Uint8Array;
  /**
   * Байты заголовка, которыми подписан шифротекст (AAD версии 2). Заполняет
   * разбор контейнера; при записи заголовок собирается заново из полей.
   */
  aad?: Uint8Array;
  /** Подсказка к паролю, если задана. Хранится открытым текстом намеренно. */
  hint?: string;
}

/**
 * Ключ хранилища: из него выводятся ключи отдельных заметок (ТЗ §3.3).
 *
 * Пароль спрашивается ОДИН раз — при установке шифрования, — и дальше живёт
 * только в этом объекте до автозамка. Argon2id прогоняется один раз за сеанс,
 * а не на каждую заметку: при 64 МиБ и трёх итерациях второе было бы секундой
 * ожидания на каждое открытие.
 *
 * Соль хранится рядом с ключом, потому что она нужна при записи КАЖДОГО
 * контейнера: без неё этот же пароль не выведет этот же ключ после
 * перезапуска.
 */
export interface MasterKey {
  readonly key: CryptoKey;
  readonly salt: Uint8Array;
}

export interface CryptoProvider {
  /**
   * Argon2id по RFC 9106 → сырой ключевой материал.
   *
   * Сырые байты нужны ровно в одном месте — чтобы отдать их платформенному
   * хранилищу (Android Keystore · Windows Hello · WebAuthn PRF). Тогда
   * разблокировка биометрией не прогоняет Argon2id вообще, а пароль в
   * хранилище не попадает.
   */
  deriveMasterMaterial(password: string, salt: Uint8Array): Promise<Uint8Array>;
  /** Материал → неэкспортируемый ключ хранилища. */
  importMaster(material: Uint8Array, salt: Uint8Array): Promise<MasterKey>;
  /** HKDF: ключ конкретной заметки по её `keyId` из заголовка контейнера. */
  deriveNoteKey(master: MasterKey, keyId: Uint8Array): Promise<CryptoKey>;
  /** Пароль → ключ хранилища одним вызовом (`deriveMasterMaterial` + `importMaster`). */
  deriveMaster(password: string, salt: Uint8Array): Promise<MasterKey>;
  /** Ключ контейнера версии 1 — только для чтения старых файлов. */
  deriveLegacyKey(password: string, salt: Uint8Array): Promise<CryptoKey>;
  encrypt(plaintext: string, key: CryptoKey, hint?: string): Promise<Uint8Array>;
  /** null — пароль не подошёл (BEHAVIOR §5.2, без исключений в UI). */
  decrypt(container: Uint8Array, key: CryptoKey): Promise<string | null>;
  parseHeader(
    container: Uint8Array,
  ): Pick<EncryptedContainer, 'version' | 'salt' | 'hint' | 'keyId'> | null;
  randomSalt(): Uint8Array;
  randomKeyId(): Uint8Array;
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
  /**
   * Сколько изменений ждут отправки.
   *
   * Нужно ровно затем, что синхронизация — не обязательное условие работы:
   * пока места нет или до него не дозвониться, правки копятся локально, и
   * человек имеет право видеть, сколько именно ждёт очереди. Без этого числа
   * экран настроек умеет сказать только «Синхронизировано» — и говорит это в
   * том числе тогда, когда обмена не было ни одного.
   */
  pending?: number;
  /** Текст из реестра BEHAVIOR §11, если state === 'error'. */
  error?: string;
}

export interface RemoteEntry {
  path: VaultPath;
  etag: string;
  mtime: number;
  size: number;
}

/** Общий интерфейс для LocalFolder / WebDAV / ЯндексДиск / ZapiskiCloud. */
export interface SyncBackend {
  readonly id: 'local' | 'webdav' | 'yandex' | 'zapiski';
  readonly title: string;
  /**
   * Кто именно на той стороне: адрес сервера, корень папки — что угодно
   * постоянное для ЭТОГО контрагента.
   *
   * Нужно затем, что движок синка помнит по каждому пути `etag` и хеш
   * последнего согласованного содержимого, а эта память имеет смысл только
   * рядом с тем, с кем сходились. Без различения двух WebDAV-серверов (у них
   * общий `id`) память одного применялась бы ко второму: «локально не
   * менялось, у них etag другой» — и чужая версия молча ложилась бы поверх
   * своей. Не задан — считаем, что место одно на весь `id`.
   */
  readonly origin?: string;
  list(): Promise<RemoteEntry[]>;
  get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null>;
  put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }>;
  remove(path: VaultPath): Promise<void>;
  /**
   * Пути, удалённые НА ТОЙ СТОРОНЕ после `since` — надгробия.
   *
   * Необязательный порт: он есть только там, где удаление оставляет след.
   * Облако Записок такой след держит (`blobs.deleted_at`), а обычная папка,
   * WebDAV и Яндекс.Диск — нет: у них удалённый файл просто отсутствует, и
   * отличить «удалили» от «ещё не залили» невозможно в принципе.
   *
   * Без этого порта удаление ездит только В облако, но не ИЗ него: удалил на
   * телефоне — на Windows заметка осталась, и первая же синхронизация вернула
   * её обратно на телефон. Именно это заказчик и описал словами «в нашем
   * облаке практически невозможно удалить ЗАПИСКУ».
   */
  removals?(since: number): Promise<VaultPath[]>;
  /** Мгновенный синк там, где он есть (websocket у ZapiskiCloud). */
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

// ─────────────────────────────────────────────────────────────────────────────
// Дополнение ядра (@zapiski/core). Добавлено реализацией, существующие
// сигнатуры выше не изменялись. Владелец файла — CTO; при переносе этих типов
// в основной раздел ничего в ядре не сломается.
// ─────────────────────────────────────────────────────────────────────────────

/** Параметры печати PDF: всегда светлая «Бумага», колонка 640 (BEHAVIOR §9). */
export interface PdfPageSetup {
  columnWidth: number;
  marginMm: number;
  theme: 'paper';
}

/**
 * Платформенный порт печати. Ядро готовит самодостаточный HTML, растеризацию
 * делает движок печати платформы (Chromium в вебе, WebView в Tauri) — только
 * так кириллица печатается с нормальными шрифтами и переносами.
 */
export interface PdfRenderer {
  render(html: string, setup: PdfPageSetup): Promise<Uint8Array>;
}
