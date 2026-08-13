/**
 * `ZapiskiCloudBackend` — Облако Записок по протоколу ADR-0003, эндпоинты
 * `/api/v1/vault/*`. Типы запросов и ответов — из `sync/protocol.ts`, того же
 * файла, который импортирует сервер.
 *
 * Сервер видит только зашифрованные байты (ТЗ §2.1.5): ключ на устройстве,
 * расшифровка на сервере невозможна технически.
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

  constructor(options: ZapiskiCloudOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://zapiski.cmpas.ru').replace(/\/+$/, '');
    this.token = options.token;
    this.deviceId = options.deviceId;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.websocket = options.websocket;
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

  async get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null> {
    const response = await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(normalizePath(path))}`);
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      etag: response.headers.get('etag')?.replace(/"/g, '') ?? '',
    };
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (ifMatch !== undefined && ifMatch !== '') headers['If-Match'] = `"${ifMatch}"`;
    const response = await this.call(`${VAULT_ENDPOINTS.blob}?path=${encodeURIComponent(normalizePath(path))}`, {
      method: 'PUT',
      headers,
      body: data as unknown as BodyInit,
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
    const payload: CloudPushRequest = {
      deviceId: this.deviceId,
      updates: updates.map((item) => ({ noteId: item.noteId, update: toBase64(item.update) })),
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
    return (body.updates ?? []).map((item) => ({ noteId: item.noteId, update: fromBase64(item.update) }));
  }
}
