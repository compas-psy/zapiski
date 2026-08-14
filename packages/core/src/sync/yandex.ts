/**
 * `YandexDiskBackend` — нативный REST поверх OAuth (ТЗ §4.1: «для Я.Диска
 * дополнительно нативный REST OAuth-коннектор для скорости»), с падением
 * обратно на WebDAV, если REST недоступен.
 *
 * REST API: https://cloud-api.yandex.net/v1/disk/resources — загрузка и
 * скачивание идут по одноразовым ссылкам, поэтому каждая операция — два
 * запроса. Зато нет PROPFIND на всё дерево и нет ограничений WebDAV-шлюза.
 */
import type { RemoteEntry, SyncBackend, VaultPath } from '../contract.js';
import { catalog, DEFAULT_LOCALE, type Locale } from '../i18n/i18n.js';
import { normalizePath } from '../util/path.js';
import { SyncError, WebDAVBackend, type FetchLike } from './webdav.js';

const REST_BASE = 'https://cloud-api.yandex.net/v1/disk/resources';
const WEBDAV_BASE = 'https://webdav.yandex.ru';

export interface YandexDiskOptions {
  /** OAuth-токен Яндекс ID (ТЗ §5.5 — основной путь входа). */
  token: string;
  /** Папка vault'а на Диске, например `Приложения/ЗАПИСКИ`. */
  root?: string;
  fetch?: FetchLike;
  locale?: Locale;
  /** Принудительно работать через WebDAV (диагностика, корпоративные прокси). */
  forceWebdav?: boolean;
}

interface YandexResource {
  name: string;
  path: string;
  type: 'dir' | 'file';
  md5?: string;
  modified?: string;
  size?: number;
  _embedded?: { items: YandexResource[] };
}

export class YandexDiskBackend implements SyncBackend {
  readonly id = 'yandex' as const;
  readonly title = 'Яндекс.Диск';
  /** Диск у аккаунта один; место различать не по чему, и не нужно. */
  readonly origin = 'yandex-disk';
  private readonly token: string;
  private readonly root: string;
  private readonly fetchImpl: FetchLike;
  private readonly locale: Locale;
  private readonly fallback: WebDAVBackend;
  /** Переключается в true, если REST ответил неожиданно — дальше идём по WebDAV. */
  private useWebdav: boolean;

  constructor(options: YandexDiskOptions) {
    this.token = options.token;
    this.root = normalizePath(options.root ?? 'Приложения/ЗАПИСКИ');
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.useWebdav = options.forceWebdav ?? false;
    this.fallback = new WebDAVBackend({
      baseUrl: `${WEBDAV_BASE}/${this.root}`,
      authorization: `OAuth ${this.token}`,
      title: this.title,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      locale: this.locale,
    });
  }

  private get strings() {
    return catalog(this.locale);
  }

  private diskPath(path: VaultPath): string {
    return `disk:/${this.root}${path === '' ? '' : `/${normalizePath(path)}`}`;
  }

  private async rest(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: { Authorization: `OAuth ${this.token}`, ...(init.headers as Record<string, string>) },
      });
    } catch {
      throw new SyncError(this.strings.errors.webdavUnreachable, 'unreachable');
    }
    if (response.status === 401) {
      // «Нужно снова войти в Яндекс.Диск» (BEHAVIOR §11).
      throw new SyncError(this.strings.errors.yandexTokenExpired, 'auth');
    }
    return response;
  }

  async list(): Promise<RemoteEntry[]> {
    if (this.useWebdav) return this.fallback.list();
    const out: RemoteEntry[] = [];
    const walk = async (relative: VaultPath): Promise<void> => {
      const url = `${REST_BASE}?path=${encodeURIComponent(this.diskPath(relative))}&limit=1000`;
      const response = await this.rest(url);
      if (response.status === 404) return;
      if (!response.ok) {
        this.useWebdav = true;
        return;
      }
      const body = (await response.json()) as YandexResource;
      for (const item of body._embedded?.items ?? []) {
        const child = relative === '' ? item.name : `${relative}/${item.name}`;
        if (item.type === 'dir') await walk(child);
        else {
          out.push({
            path: child,
            etag: item.md5 ?? String(Date.parse(item.modified ?? '') || 0),
            mtime: Date.parse(item.modified ?? '') || 0,
            size: item.size ?? 0,
          });
        }
      }
    };
    await walk('');
    return this.useWebdav ? this.fallback.list() : out;
  }

  async get(path: VaultPath): Promise<{ data: Uint8Array; etag: string } | null> {
    if (this.useWebdav) return this.fallback.get(path);
    const link = await this.rest(`${REST_BASE}/download?path=${encodeURIComponent(this.diskPath(path))}`);
    if (link.status === 404) return null;
    if (!link.ok) {
      this.useWebdav = true;
      return this.fallback.get(path);
    }
    const { href } = (await link.json()) as { href: string };
    const file = await this.rest(href, { method: 'GET' });
    if (!file.ok) return null;
    const data = new Uint8Array(await file.arrayBuffer());
    return { data, etag: file.headers.get('etag')?.replace(/"/g, '') ?? '' };
  }

  async put(path: VaultPath, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    if (this.useWebdav) return this.fallback.put(path, data, ifMatch);
    await this.ensureDirs(path);
    const link = await this.rest(
      `${REST_BASE}/upload?path=${encodeURIComponent(this.diskPath(path))}&overwrite=true`,
    );
    if (!link.ok) {
      this.useWebdav = true;
      return this.fallback.put(path, data, ifMatch);
    }
    const { href } = (await link.json()) as { href: string };
    const upload = await this.rest(href, { method: 'PUT', body: data as unknown as BodyInit });
    if (!upload.ok) throw new SyncError(this.strings.errors.syncFailed, 'server');
    return { etag: upload.headers.get('etag')?.replace(/"/g, '') ?? String(Date.now()) };
  }

  async remove(path: VaultPath): Promise<void> {
    if (this.useWebdav) {
      await this.fallback.remove(path);
      return;
    }
    await this.rest(`${REST_BASE}?path=${encodeURIComponent(this.diskPath(path))}&permanently=false`, {
      method: 'DELETE',
    });
  }

  private async ensureDirs(path: VaultPath): Promise<void> {
    const parts = normalizePath(path).split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current === '' ? part : `${current}/${part}`;
      await this.rest(`${REST_BASE}?path=${encodeURIComponent(this.diskPath(current))}`, { method: 'PUT' }).catch(
        () => undefined,
      );
    }
  }
}
