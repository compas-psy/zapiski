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
import { looksLikeEnvelope, SyncCrypto } from './sync-crypto.js';
import { SyncError, type FetchLike } from './webdav.js';

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
    return (body.entries ?? []).map((entry) => ({
      path: normalizePath(entry.path),
      etag: entry.etag,
      mtime: entry.mtime,
      size: entry.size,
    }));
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
    return (body?.removed ?? []).map((path) => normalizePath(path));
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

  async get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null> {
    const response = await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(normalizePath(path))}`);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const raw = new Uint8Array(await response.arrayBuffer());
    const data = await this.unseal(path, raw);
    if (data === null) return null;
    return {
      data,
      etag: response.headers.get('etag')?.replace(/"/g, '') ?? '',
    };
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (ifMatch !== undefined && ifMatch !== '') headers['If-Match'] = `"${ifMatch}"`;
    /* SEC-001, граница §1: за этой строкой открытого текста заметки больше
       нет — ни в теле запроса, ни в памяти сетевого слоя. */
    const body =
      this.sync === undefined ? data : await this.sync.sealContent(normalizePath(path), data);
    const response = await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(normalizePath(path))}`, {
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
    await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(normalizePath(path))}`, { method: 'DELETE' });
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
