/**
 * `ZapiskiCloudBackend` — Облако Записок по протоколу ADR-0003, эндпоинты
 * `/api/v1/vault/*`. Типы запросов и ответов — из `sync/protocol.ts`, того же
 * файла, который импортирует сервер.
 *
 * ЗДЕСЬ СТОИТ ГРАНИЦА ШИФРОВАНИЯ SEC-001 (design §1). Если бэкенду отдан
 * `sync` (`SyncCrypto`), то за `put`/`pushUpdates` открытого текста больше
 * нет — на сервер уходит только конверт AES-256-GCM под доменным ключом
 * заметки, а `get`/`pullUpdates` снимают конверт на входе.
 *
 * `sync` необязателен, и это не лазейка, а требование совместимости
 * (design §13): аккаунт остаётся незашифрованным до первого добровольного
 * онбординга SMK, и до него бэкенд обязан читать уже лежащие в облаке
 * открытые объекты — иначе включение шифрования выглядело бы как пропажа
 * заметок. Что аккаунт уже перешёл на шифрование, видно по `encrypts`.
 *
 * Временный kill-switch
 * (`CLOUD_SYNC_ENABLED`, `core/cloud-sync.ts`) стоит НЕ здесь, а на
 * прикладном уровне: `createCloudBackend`
 * (`packages/app/src/state/cloud.ts`) отказывается собрать этот бэкенд
 * для настоящего сетевого адреса, и `AppController.connectCloud`/
 * `resumeCloud` (`packages/app/src/state/store.ts`) не доходят даже до
 * вызова фабрики. Тот же класс, сконструированный тестом на подставном
 * `fetch`, флага не видит и не обязан — он не разговаривает с настоящим
 * сервером.
 */
import type { NoteId, RemoteEntry, SyncBackend, VaultPath } from '../contract.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { fromBase64, toBase64 } from '../util/bytes.js';
import { normalizePath } from '../util/path.js';
import {
  VAULT_ENDPOINTS,
  type CloudErrorDto,
  type CloudListResponse,
  type CloudPullRequest,
  type CloudPullResponse,
  type CloudPushRequest,
  type CloudPushResponse,
  type CloudSubscribeEvent,
} from './protocol.js';
import {
  buildManifest,
  MANIFEST_ADDRESS,
  openManifest,
  sealManifest,
} from './manifest.js';
import { looksLikeEnvelope, SyncCrypto } from './sync-crypto.js';
import { SyncError, type FetchLike } from './webdav.js';

/**
 * Как выглядит адрес объекта у зашифрованного аккаунта: 128 бит `HMAC-SHA256`
 * от пути, в hex (`SyncCrypto.pathToken`). Отличить его от настоящего пути
 * достаточно по форме — в путях vault'а есть точка расширения и почти всегда
 * есть буквы вне `a–f`, а ровно 32 шестнадцатеричных знака без точки путём
 * заметки быть не может.
 */
const SYNC_ADDRESS = /^[0-9a-f]{32}$/;

export interface ZapiskiCloudOptions {
  /** Базовый адрес, по умолчанию — `https://zapiski.cmpas.ru` (ADR-0003 §1). */
  baseUrl?: string;
  /** Токен доступа: Яндекс ID или magic-link (ТЗ §5.5, паролей нет). */
  token: string;
  deviceId: string;
  fetch?: FetchLike;
  locale?: Locale;
  /** Фабрика websocket — платформенная, поэтому инъекция (ARCHITECTURE §2). */
  websocket?: (url: string) => WebSocketLike;
  /**
   * SEC-001: граница шифрования. Если задана — НИ ОДИН байт содержимого не
   * уходит на сервер и не приходит с него без конверта (design §1).
   *
   * Необязательна намеренно: аккаунт остаётся незашифрованным до первого
   * добровольного онбординга SMK (design §13, «раскатка по аккаунту, не
   * мгновенно и не принудительно»), и до него бэкенд обязан продолжать
   * работать со старыми открытыми объектами, иначе у человека пропадут уже
   * лежащие в облаке заметки. Как только `sync` задан — новые записи идут
   * только шифротекстом.
   */
  sync?: SyncCrypto;
}

export interface WebSocketLike {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export class ZapiskiCloudBackend implements SyncBackend {
  readonly id = 'zapiski' as const;
  readonly title = 'Облако Записок';
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly deviceId: string;
  private readonly fetchImpl: FetchLike;
  private readonly locale: Locale;
  private readonly websocket: ((url: string) => WebSocketLike) | undefined;
  private readonly sync: SyncCrypto | undefined;

  constructor(options: ZapiskiCloudOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://zapiski.cmpas.ru').replace(/\/+$/, '');
    this.token = options.token;
    this.deviceId = options.deviceId;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.websocket = options.websocket;
    this.sync = options.sync;
  }

  /** Включено ли шифрование синка на этом бэкенде (SEC-001). */
  get encrypts(): boolean {
    return this.sync !== undefined;
  }

  /**
   * SEC-001 §7 — адрес объекта на сервере.
   *
   * Без шифрования — путь как есть (совместимость). С шифрованием — токен
   * `HMAC(K_manifest, путь)`: сервер перестаёт видеть названия папок и
   * заголовки заметок в `blobs.path`.
   *
   * Обратное соответствие держится ЛОКАЛЬНО (`tokenToPath`): токен
   * детерминирован, поэтому устройство, знающее свой vault, восстанавливает
   * соответствие само, ничего не спрашивая у сервера. Для путей, которых
   * это устройство ещё не видело (заметка создана на другом устройстве),
   * соответствие берётся из зашифрованного манифеста — он и существует
   * ровно для этого.
   */
  private async addressOf(path: VaultPath): Promise<string> {
    const normalized = normalizePath(path);
    if (this.sync === undefined) return normalized;
    const token = await this.sync.pathToken(normalized);
    this.tokenToPath.set(token, normalized);
    return token;
  }

  /** Локальная карта «адрес на сервере → путь в vault'е». */
  private readonly tokenToPath = new Map<string, VaultPath>();

  /**
   * Научить бэкенд адресам заметок, которых он ещё не видел.
   *
   * Вызывается после расшифровки манифеста: без этого `list()` вернул бы
   * токены, а синк принял бы их за имена файлов и создал бы на диске мусор
   * вида `9f3a…`. Пустой список — не ошибка: у аккаунта может не быть ни
   * одной заметки с другого устройства.
   */
  async learnPaths(paths: readonly VaultPath[]): Promise<void> {
    if (this.sync === undefined) return;
    for (const path of paths) {
      const normalized = normalizePath(path);
      this.tokenToPath.set(await this.sync.pathToken(normalized), normalized);
    }
  }

  /** Все пути, которые этот бэкенд умеет адресовать, — для манифеста. */
  knownPaths(): VaultPath[] {
    return [...this.tokenToPath.values()];
  }

  /**
   * Забрать манифест с сервера и выучить пути (SEC-001 §7).
   *
   * Это ПЕРВОЕ, что делает новое устройство: без него `list()` вернёт
   * токены, которых устройство не знает, и заметки, созданные на другом
   * устройстве, окажутся невидимыми. Возвращает число выученных путей —
   * ноль означает «манифеста ещё нет» (первое устройство аккаунта), а не
   * ошибку.
   *
   * Без шифрования манифест не нужен вовсе: адрес и есть путь.
   */
  async pullManifest(): Promise<number> {
    if (this.sync === undefined) return 0;
    const response = await this.call(
      `${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(MANIFEST_ADDRESS)}`,
    ).catch(() => null);
    if (!response || !response.ok) return 0;
    const manifest = await openManifest(this.sync, new Uint8Array(await response.arrayBuffer()));
    if (manifest === null) return 0;
    await this.learnPaths(manifest.paths);
    return manifest.paths.length;
  }

  /**
   * Опубликовать манифест из путей, которые знает это устройство.
   *
   * Отставший манифест не теряет данные (заметка на сервере есть), поэтому
   * отказ здесь не срывает синк — он вернёт `false`, и следующий оборот
   * попробует снова.
   */
  async pushManifest(paths: readonly VaultPath[]): Promise<boolean> {
    if (this.sync === undefined) return false;
    await this.learnPaths(paths);
    const sealed = await sealManifest(this.sync, buildManifest(paths));
    const response = await this.call(
      `${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(MANIFEST_ADDRESS)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: sealed as unknown as BodyInit,
      },
    ).catch(() => null);
    return response !== null && response.ok;
  }

  /** Адрес облака: тестовый стенд и прод — не одно и то же место. */
  get origin(): string {
    return this.baseUrl;
  }

  private get strings() {
    return catalog(this.locale);
  }

  /**
   * Что сказать человеку про 402.
   *
   * Раньше здесь стояла одна строка на все случаи — «Подписка закончилась». У
   * того, кто только что завёл аккаунт, подписки не было ни разу, и сообщение
   * рассказывало о конце того, что не начиналось. Сервер различает эти случаи
   * кодом (`subscription_required` / `subscription_expired`), и текст берётся
   * по коду, а не по номеру ответа. Текст — свой, а не серверный: он обязан
   * быть на языке приложения.
   */
  private async paymentMessage(response: Response): Promise<string> {
    const code = await response
      .clone()
      .json()
      .then((body: unknown) => (body as { error?: { code?: string } }).error?.code)
      .catch(() => undefined);
    return code === 'subscription_expired'
      ? this.strings.errors.subscriptionExpired
      : this.strings.errors.subscriptionRequired;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Device-Id': this.deviceId,
          ...(init.headers as Record<string, string>),
        },
      });
    } catch {
      throw new SyncError(this.strings.errors.syncFailed, 'unreachable');
    }
    if (response.status === 401) throw new SyncError(this.strings.errors.magicLinkExpired, 'auth');
    if (response.status === 402) throw new SyncError(await this.paymentMessage(response), 'auth');
    if (response.status >= 500) throw new SyncError(this.strings.errors.syncFailed, 'server');
    return response;
  }

  async list(): Promise<RemoteEntry[]> {
    const response = await this.call(VAULT_ENDPOINTS.list);
    if (!response.ok) return [];
    const body = (await response.json()) as CloudListResponse;
    const entries = body.entries ?? [];
    /*
     * Неизвестный адрес — это почти всегда заметка с ДРУГОГО устройства, а не
     * мусор: соответствие «токен → путь» приезжает в зашифрованном оглавлении
     * (`pullManifest`). Достаём его прямо здесь, потому что список — то
     * единственное место, где недостача обнаруживается, и потому что иначе
     * заметки, созданные на втором устройстве, не появляются на первом
     * никогда: оглавление тянулось ровно один раз, при подключении.
     *
     * Один запрос и только когда есть чего не хватать.
     */
    if (this.sync !== undefined && entries.some((entry) => this.isUnknownAddress(entry.path))) {
      await this.pullManifest().catch(() => 0);
    }
    return entries
      .map((entry) => {
        /* SEC-001 §7: с сервера приходит адрес, а не путь. Неизвестный адрес
           пропускается, а не превращается в файл с именем-токеном: заметка,
           созданная на другом устройстве, появится после расшифровки
           манифеста (`learnPaths`), и это лучше, чем мусор на диске. */
        if (entry.path === MANIFEST_ADDRESS) return null; // служебный объект, не заметка
        const path = this.pathOfAddress(entry.path);
        if (path === null) return null;
        return { path, etag: entry.etag, mtime: entry.mtime, size: entry.size };
      })
      .filter((entry): entry is RemoteEntry => entry !== null);
  }

  /**
   * Пути, удалённые на сервере после `since` — надгробия (`blobs.deleted_at`).
   *
   * Сервер отдавал их с самого начала (`includeDeleted=1` → поле `removed`), а
   * клиент не спрашивал и не читал: половина протокола удалений была написана и
   * не соединена. Из-за этого удаление ездило только В облако — удалил на
   * телефоне, на Windows заметка осталась и вернулась обратно.
   *
   * Отказ — пустой список, а не исключение: надгробия уточняют обмен, а не
   * несут его. Сорвать из-за них весь синк было бы хуже.
   */
  async removals(since: number): Promise<VaultPath[]> {
    const url = `${VAULT_ENDPOINTS.list}?since=${Math.max(0, Math.floor(since))}&includeDeleted=1`;
    const response = await this.call(url).catch(() => null);
    if (!response || !response.ok) return [];
    const body = (await response.json().catch(() => null)) as CloudListResponse | null;
    return (body?.removed ?? [])
      .map((address) => this.pathOfAddress(address))
      .filter((path): path is VaultPath => path !== null);
  }

  /**
   * SEC-001: снятие конверта на входе.
   *
   * Открытые байты (аккаунт ещё не перешифрован, design §10) пропускаются
   * как есть — иначе переход на шифрование выглядел бы как исчезновение уже
   * лежащих в облаке заметок. Конверт, который НЕ открылся нашим ключом, —
   * это не «пустая заметка»: возвращаем `null`, и синк обходится с ним как
   * с недоступным объектом (design §9), а не подсовывает человеку мусор.
   */
  private async unseal(path: VaultPath, data: Uint8Array): Promise<Uint8Array | null> {
    if (this.sync === undefined) return data;
    if (!looksLikeEnvelope(data)) return data;
    return this.sync.openContent(normalizePath(path), data);
  }

  /** Прочитать объект по АДРЕСУ на сервере, без расшифровки. */
  private async readAddress(address: string): Promise<{ raw: Uint8Array; etag: string } | null> {
    const response = await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(address)}`);
    if (response.status === 404 || !response.ok) return null;
    return {
      raw: new Uint8Array(await response.arrayBuffer()),
      etag: response.headers.get('etag')?.replace(/"/g, '') ?? '',
    };
  }

  /** Удалить объект по АДРЕСУ на сервере. */
  private async deleteAddress(address: string): Promise<void> {
    await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(address)}`, {
      method: 'DELETE',
    });
  }

  /** Знает ли это устройство, какой заметке принадлежит адрес. */
  private isUnknownAddress(address: string): boolean {
    return address !== MANIFEST_ADDRESS && this.pathOfAddress(address) === null;
  }

  async get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null> {
    const address = await this.addressOf(path);
    const found = await this.readAddress(address);
    if (found === null) return null;
    const raw = found.raw;
    const data = await this.unseal(path, raw);
    if (data === null) return null;
    return { data, etag: found.etag };
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (ifMatch !== undefined && ifMatch !== '') headers['If-Match'] = `"${ifMatch}"`;
    /* SEC-001, граница §1: за этой строкой открытого текста заметки больше
       нет — ни в теле запроса, ни в памяти сетевого слоя. */
    const body =
      this.sync === undefined ? data : await this.sync.sealContent(normalizePath(path), data);
    const address = await this.addressOf(path);
    const response = await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(address)}`, {
      method: 'PUT',
      headers,
      body: body as unknown as BodyInit,
    });
    if (response.status === 409 || response.status === 412) {
      const error = (await response.json().catch(() => ({ code: 'conflict' }))) as CloudErrorDto;
      throw new SyncError(this.strings.errors.conflictMerged, error.code === 'conflict' ? 'conflict' : 'server');
    }
    if (!response.ok) throw new SyncError(this.strings.errors.syncFailed, 'server');
    return { etag: response.headers.get('etag')?.replace(/"/g, '') ?? String(Date.now()) };
  }

  async remove(path: VaultPath): Promise<void> {
    await this.deleteAddress(await this.addressOf(path));
  }

  /**
   * Перевести объекты прошлых версий на шифрование (SEC-001 §10).
   *
   * ── Зачем это вообще нужно ───────────────────────────────────────────────
   *
   * До SEC-001 Облако адресовало заметку её ПУТЁМ и хранило содержимое как
   * есть. После — адрес это токен `HMAC(K_manifest, путь)`, а содержимое
   * конверт. Значит объект, оставшийся с прошлых версий, для нового клиента
   * не существует: по токену его нет, а его собственный адрес ни один
   * `list()` в путь не превращает. Человек увидел бы, что заметки из облака
   * пропали, — и это была бы неправда только наполовину: локально они есть, а
   * в облаке лежат, и лежат ОТКРЫТЫМ ТЕКСТОМ, что и есть сама находка
   * SEC-001.
   *
   * Поэтому переезд обязателен и обязателен целиком: перечитать открытый
   * объект, положить его запечатанным по новому адресу и УБРАТЬ открытую
   * копию. Оставить её значило бы объявить аккаунт зашифрованным, держа
   * рядом ту же заметку в открытом виде.
   *
   * Возвращает число переехавших объектов; ноль — что переезжать нечего
   * (аккаунт заведён уже после перехода), а не что что-то сломалось. Вызов
   * идемпотентен: второй раз находить нечего.
   *
   * Объект, который не открылся нашим ключом, не трогается вовсе (design §9):
   * это не наш мусор, а чужие или повреждённые байты, и удалять их — значит
   * терять чужие данные по догадке.
   */
  async migrateLegacy(): Promise<number> {
    if (this.sync === undefined) return 0;
    const response = await this.call(VAULT_ENDPOINTS.list).catch(() => null);
    if (!response || !response.ok) return 0;
    const body = (await response.json().catch(() => null)) as CloudListResponse | null;
    let moved = 0;
    for (const entry of body?.entries ?? []) {
      if (entry.path === MANIFEST_ADDRESS) continue;
      if (SYNC_ADDRESS.test(entry.path)) continue; // уже переведён
      const path = normalizePath(entry.path);
      const found = await this.readAddress(entry.path).catch(() => null);
      if (found === null) continue;
      const data = await this.unseal(path, found.raw);
      if (data === null) continue; // чужим ключом не открылось — не наше
      await this.put(path, data);
      await this.deleteAddress(entry.path);
      moved += 1;
    }
    if (moved > 0) await this.pushManifest(this.knownPaths());
    return moved;
  }

  /**
   * Адрес с сервера → путь в vault'е. `null`, если адрес незнаком.
   *
   * Без шифрования адрес и есть путь — тогда возвращается он сам.
   */
  private pathOfAddress(address: string): VaultPath | null {
    if (this.sync === undefined) return normalizePath(address);
    return this.tokenToPath.get(address) ?? null;
  }

  /** Мгновенный синк по websocket (ТЗ §4.1, BEHAVIOR §6). */
  subscribe(onChange: (path: VaultPath) => void): () => void {
    if (!this.websocket) return () => undefined;
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${VAULT_ENDPOINTS.subscribe}?device=${encodeURIComponent(
      this.deviceId,
    )}`;
    const socket = this.websocket(url);
    socket.addEventListener('message', (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as CloudSubscribeEvent;
        if (parsed && typeof parsed.path === 'string') onChange(normalizePath(parsed.path));
      } catch {
        // Мусор в сокете не должен ронять синк.
      }
    });
    return () => socket.close();
  }

  /** Пакетная выгрузка CRDT-обновлений (delta-синк, ТЗ §4.1). */
  async pushUpdates(updates: Array<{ noteId: NoteId; update: Uint8Array }>): Promise<CloudPushResponse> {
    /* SEC-001 §8.4: CRDT-апдейт — такой же шифротекст, как содержимое, и под
       СВОИМ доменным ключом (`K_crdt` заметки), а не общим с содержимым. */
    const sealed = await Promise.all(
      updates.map(async (item) => ({
        noteId: item.noteId,
        update: this.sync === undefined ? item.update : await this.sync.sealCrdt(item.noteId, item.update),
      })),
    );
    const payload: CloudPushRequest = {
      deviceId: this.deviceId,
      updates: sealed.map((item) => ({ noteId: item.noteId, update: toBase64(item.update) })),
    };
    const response = await this.call(VAULT_ENDPOINTS.push, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new SyncError(this.strings.errors.syncFailed, 'server');
    return (await response.json()) as CloudPushResponse;
  }

  /** Загрузка дельт по вектору состояния. */
  async pullUpdates(
    vectors: Array<{ noteId: NoteId; stateVector: Uint8Array }>,
  ): Promise<Array<{ noteId: NoteId; update: Uint8Array }>> {
    const payload: CloudPullRequest = {
      deviceId: this.deviceId,
      stateVectors: vectors.map((item) => ({ noteId: item.noteId, stateVector: toBase64(item.stateVector) })),
    };
    const response = await this.call(VAULT_ENDPOINTS.pull, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new SyncError(this.strings.errors.syncFailed, 'server');
    const body = (await response.json()) as CloudPullResponse;
    const raw = (body.updates ?? []).map((item) => ({ noteId: item.noteId, update: fromBase64(item.update) }));
    if (this.sync === undefined) return raw;
    const opened = await Promise.all(
      raw.map(async (item) => {
        if (!looksLikeEnvelope(item.update)) return item; // ещё не перешифрованный апдейт
        const update = await this.sync!.openCrdt(item.noteId, item.update);
        return update === null ? null : { noteId: item.noteId, update };
      }),
    );
    /* Не открывшийся чужим ключом апдейт молча выбрасывается, а не применяется
       мусором к документу: применить нерасшифрованные байты к CRDT — верный
       способ повредить заметку (design §9). */
    return opened.filter((item): item is { noteId: NoteId; update: Uint8Array } => item !== null);
  }
}
