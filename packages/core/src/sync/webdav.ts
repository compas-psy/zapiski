/**
 * `WebDAVBackend` — универсальный WebDAV (ТЗ §4.1), включая Яндекс.Диск по
 * WebDAV. Версионирование — `ETag`, при его отсутствии `getlastmodified`
 * (ТЗ §4.2).
 *
 * Сетевого клиента здесь нет: используется `fetch`, который на всех трёх целях
 * один и тот же (веб, Tauri desktop, Tauri Android) — ADR-0001.
 */
import type { RemoteEntry, SyncBackend, VaultPath } from '../contract.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { normalizePath } from '../util/path.js';
import { toBase64 } from '../util/bytes.js';
import { PreconditionFailed } from './local-folder.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebDAVOptions {
  /** Базовый URL каталога vault'а, например `https://webdav.yandex.ru/Заметки`. */
  baseUrl: string;
  username?: string;
  password?: string;
  /** Готовый заголовок авторизации (OAuth) вместо логина и пароля. */
  authorization?: string;
  title?: string;
  fetch?: FetchLike;
  locale?: Locale;
}

/** Ошибка синка с текстом строго из реестра BEHAVIOR §11. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'unreachable' | 'conflict' | 'server',
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export class WebDAVBackend implements SyncBackend {
  readonly id = 'webdav' as const;
  /** Адрес сервера: два разных WebDAV — два разных места, память не общая. */
  get origin(): string {
    return this.baseUrl;
  }
  readonly title: string;
  protected readonly baseUrl: string;
  protected readonly fetchImpl: FetchLike;
  protected readonly locale: Locale;
  private readonly authorization: string | undefined;

  constructor(options: WebDAVOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.title = options.title ?? 'WebDAV';
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.authorization =
      options.authorization ??
      (options.username !== undefined
        ? `Basic ${toBase64(new TextEncoder().encode(`${options.username}:${options.password ?? ''}`))}`
        : undefined);
  }

  protected get strings() {
    return catalog(this.locale);
  }

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authorization !== undefined) headers['Authorization'] = this.authorization;
    return headers;
  }

  protected urlFor(path: VaultPath): string {
    const encoded = normalizePath(path)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.baseUrl}/${encoded}`;
  }

  protected async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      // Сервер не отвечает (BEHAVIOR §11).
      throw new SyncError(this.strings.errors.webdavUnreachable, 'unreachable');
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncError(this.strings.errors.webdavAuth, 'auth');
    }
    if (response.status === 412) throw new PreconditionFailed(url, response.headers.get('etag') ?? '');
    if (response.status >= 500) throw new SyncError(this.strings.errors.webdavUnreachable, 'server');
    return response;
  }

  async list(): Promise<RemoteEntry[]> {
    const response = await this.request(this.baseUrl, {
      method: 'PROPFIND',
      headers: this.headers({ Depth: 'infinity', 'Content-Type': 'application/xml' }),
      body: PROPFIND_BODY,
    });
    if (!response.ok) return [];
    return parsePropfind(await response.text(), this.baseUrl);
  }

  async get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null> {
    const response = await this.request(this.urlFor(path), { method: 'GET', headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) return null;
    const data = new Uint8Array(await response.arrayBuffer());
    return { data, etag: normalizeEtag(response.headers.get('etag') ?? response.headers.get('last-modified') ?? '') };
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    const headers = this.headers({ 'Content-Type': 'application/octet-stream' });
    if (ifMatch !== undefined && ifMatch !== '') headers['If-Match'] = `"${ifMatch}"`;
    await this.ensureCollections(path);
    const response = await this.request(this.urlFor(path), {
      method: 'PUT',
      headers,
      body: data as unknown as BodyInit,
    });
    if (!response.ok) throw new SyncError(this.strings.errors.syncFailed, 'server');
    const etag = normalizeEtag(response.headers.get('etag') ?? '');
    if (etag !== '') return { etag };
    // Не все серверы возвращают ETag на PUT — доспрашиваем HEAD.
    const head = await this.request(this.urlFor(path), { method: 'HEAD', headers: this.headers() });
    return {
      etag: normalizeEtag(head.headers.get('etag') ?? head.headers.get('last-modified') ?? ''),
    };
  }

  async remove(path: VaultPath): Promise<void> {
    await this.request(this.urlFor(path), { method: 'DELETE', headers: this.headers() });
  }

  /** MKCOL для всех недостающих каталогов: папки vault'а — реальные каталоги. */
  protected async ensureCollections(path: VaultPath): Promise<void> {
    const parts = normalizePath(path).split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current === '' ? part : `${current}/${part}`;
      await this.request(this.urlFor(current), { method: 'MKCOL', headers: this.headers() }).catch(() => undefined);
    }
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/>
</d:prop></d:propfind>`;

export function normalizeEtag(value: string): string {
  return value.replace(/^W\//, '').replace(/"/g, '').trim();
}

/**
 * Разбор ответа PROPFIND. Полноценный XML-парсер тянуть незачем: ответ WebDAV
 * плоский, а лишняя зависимость в ядре — лишний вес на всех трёх платформах.
 */
export function parsePropfind(xml: string, baseUrl: string): RemoteEntry[] {
  const basePath = safePathname(baseUrl).replace(/\/+$/, '');
  const out: RemoteEntry[] = [];
  const responses = xml.match(/<[a-zA-Z0-9]*:?response[\s>][\s\S]*?<\/[a-zA-Z0-9]*:?response>/g) ?? [];
  for (const block of responses) {
    const href = tag(block, 'href');
    if (href === null) continue;
    const isCollection = /<[a-zA-Z0-9]*:?collection\s*\/?>/.test(block);
    if (isCollection) continue;
    const decoded = decodeURIComponent(safePathname(href));
    const relative = decoded.startsWith(basePath) ? decoded.slice(basePath.length) : decoded;
    const path = normalizePath(relative);
    if (path === '') continue;
    const etag = normalizeEtag(tag(block, 'getetag') ?? '');
    const modified = tag(block, 'getlastmodified');
    const mtime = modified ? Date.parse(modified) || 0 : 0;
    const size = Number(tag(block, 'getcontentlength') ?? '0') || 0;
    out.push({ path, etag: etag !== '' ? etag : String(mtime), mtime, size });
  }
  return out;
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<[a-zA-Z0-9]*:?${name}[^>]*>([\\s\\S]*?)</[a-zA-Z0-9]*:?${name}>`).exec(block);
  return match ? (match[1] as string).trim() : null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
