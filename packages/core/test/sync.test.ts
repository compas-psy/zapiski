/**
 * Синк-слой: бэкенды (ТЗ §4.1), очередь, история версий, устойчивость (§4.3).
 * Сетевые бэкенды проверяются на подставном `fetch` — ядро не должно ходить
 * в сеть в тестах.
 */
import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { LocalFolderBackend, PreconditionFailed, etagOf } from '../src/sync/local-folder.js';
import { WebDAVBackend, SyncError, parsePropfind, normalizeEtag } from '../src/sync/webdav.js';
import { YandexDiskBackend } from '../src/sync/yandex.js';
import { ZapiskiCloudBackend } from '../src/sync/zapiski-cloud.js';
import { VAULT_ENDPOINTS, API_PREFIX } from '../src/sync/protocol.js';
import { ChangeQueue } from '../src/sync/queue.js';
import { VersionHistory, MAX_SNAPSHOTS } from '../src/sync/versions.js';
import { SyncEngine } from '../src/sync/engine.js';
import { utf8, fromUtf8, toBase64 } from '../src/util/bytes.js';

describe('LocalFolderBackend (ТЗ §4.1)', () => {
  it('перечисляет файлы, отдаёт и принимает содержимое', async () => {
    const remote = new MemoryVaultStorage({ files: { 'Идея.md': '# Идея\n', 'Проекты/План.md': '# План\n' } });
    const backend = new LocalFolderBackend(remote);
    const entries = await backend.list();
    expect(entries.map((entry) => entry.path).sort()).toEqual(['Идея.md', 'Проекты/План.md']);

    const fetched = await backend.get('Идея.md');
    expect(fromUtf8(fetched?.data as Uint8Array)).toBe('# Идея\n');
    expect(await backend.get('Нет.md')).toBeNull();

    const { etag } = await backend.put('Новая.md', utf8('# Новая\n'));
    expect(etag).not.toBe('');
    expect(remote.snapshot()['Новая.md']).toBe('# Новая\n');

    await backend.remove('Новая.md');
    expect(remote.snapshot()['Новая.md']).toBeUndefined();
  });

  it('оптимистическая блокировка: чужая правка не затирается', async () => {
    const remote = new MemoryVaultStorage({ files: { 'Идея.md': '# Идея\n' } });
    const backend = new LocalFolderBackend(remote);
    await expect(backend.put('Идея.md', utf8('другое'), 'заведомо-чужой-etag')).rejects.toBeInstanceOf(
      PreconditionFailed,
    );
    expect(remote.snapshot()['Идея.md']).toBe('# Идея\n');
  });

  it('служебные файлы кроме CRDT-логов не синкаются', async () => {
    const remote = new MemoryVaultStorage({
      files: { 'Идея.md': '#', '.zapiski/index.json': '{}', '.zapiski/crdt/abc.bin': 'лог' },
    });
    const paths = (await new LocalFolderBackend(remote).list()).map((entry) => entry.path);
    expect(paths).toContain('.zapiski/crdt/abc.bin');
    expect(paths).not.toContain('.zapiski/index.json');

    const withoutCrdt = await new LocalFolderBackend(remote, { includeCrdt: false }).list();
    expect(withoutCrdt.map((entry) => entry.path)).toEqual(['Идея.md']);
  });

  it('etag меняется вместе с содержимым', () => {
    expect(etagOf(1, 2)).not.toBe(etagOf(1, 3));
  });
});

describe('WebDAVBackend (ТЗ §4.1, §4.2)', () => {
  const propfind = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/vault/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/vault/%D0%98%D0%B4%D0%B5%D1%8F.md</d:href><d:propstat><d:prop>
<d:getetag>"abc123"</d:getetag><d:getlastmodified>Fri, 08 Aug 2026 10:15:00 GMT</d:getlastmodified>
<d:getcontentlength>42</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
</d:multistatus>`;

  it('разбирает PROPFIND: путь, ETag, дата, размер', () => {
    const entries = parsePropfind(propfind, 'https://dav.example.com/vault');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('Идея.md');
    expect(entries[0]?.etag).toBe('abc123');
    expect(entries[0]?.size).toBe(42);
    expect(entries[0]?.mtime).toBe(Date.parse('Fri, 08 Aug 2026 10:15:00 GMT'));
    expect(normalizeEtag('W/"xyz"')).toBe('xyz');
  });

  it('list ходит методом PROPFIND с Depth и авторизацией', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const backend = new WebDAVBackend({
      baseUrl: 'https://dav.example.com/vault',
      username: 'marina',
      password: 'секрет',
      fetch: async (url, init) => {
        seen.push({ url, init: init ?? {} });
        return new Response(propfind, { status: 207 });
      },
    });
    const entries = await backend.list();
    expect(entries).toHaveLength(1);
    expect(seen[0]?.init.method).toBe('PROPFIND');
    expect((seen[0]?.init.headers as Record<string, string>)['Depth']).toBe('infinity');
    expect((seen[0]?.init.headers as Record<string, string>)['Authorization']).toContain('Basic ');
  });

  it('401 даёт текст «Сервер не принял логин или пароль» (BEHAVIOR §11)', async () => {
    const backend = new WebDAVBackend({
      baseUrl: 'https://dav.example.com/vault',
      fetch: async () => new Response('', { status: 401 }),
    });
    await expect(backend.list()).rejects.toThrow('Сервер не принял логин или пароль');
  });

  it('обрыв сети даёт «Сервер не отвечает · Повторить»', async () => {
    const backend = new WebDAVBackend({
      baseUrl: 'https://dav.example.com/vault',
      fetch: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await expect(backend.list()).rejects.toThrow('Сервер не отвечает · Повторить');
  });

  it('put шлёт If-Match и создаёт недостающие коллекции', async () => {
    const calls: string[] = [];
    const backend = new WebDAVBackend({
      baseUrl: 'https://dav.example.com/vault',
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${url}`);
        if (init?.method === 'PUT') return new Response('', { status: 201, headers: { etag: '"new"' } });
        return new Response('', { status: 200 });
      },
    });
    const result = await backend.put('Проекты/План.md', utf8('# План'), 'old');
    expect(result.etag).toBe('new');
    expect(calls.some((call) => call.startsWith('MKCOL'))).toBe(true);
    expect(calls.some((call) => call.includes('PUT'))).toBe(true);
  });

  it('412 превращается в PreconditionFailed — уходим в слияние', async () => {
    const backend = new WebDAVBackend({
      baseUrl: 'https://dav.example.com/vault',
      fetch: async (_url, init) =>
        init?.method === 'PUT' ? new Response('', { status: 412 }) : new Response('', { status: 200 }),
    });
    await expect(backend.put('Идея.md', utf8('x'), 'old')).rejects.toBeInstanceOf(PreconditionFailed);
  });
});

describe('YandexDiskBackend (ТЗ §4.1)', () => {
  it('ходит в REST по OAuth и отдаёт список файлов', async () => {
    const backend = new YandexDiskBackend({
      token: 'oauth-token',
      root: 'Приложения/ЗАПИСКИ',
      fetch: async (url, init) => {
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('OAuth oauth-token');
        if (url.includes('/download')) return new Response(JSON.stringify({ href: 'https://storage/1' }));
        if (url.startsWith('https://storage/')) {
          return new Response(utf8('# Идея\n') as unknown as BodyInit, { headers: { etag: '"e1"' } });
        }
        return new Response(
          JSON.stringify({
            name: 'ЗАПИСКИ',
            path: 'disk:/Приложения/ЗАПИСКИ',
            type: 'dir',
            _embedded: {
              items: [
                { name: 'Идея.md', path: 'disk:/…', type: 'file', md5: 'abc', modified: '2026-08-08T10:15:00+00:00', size: 7 },
              ],
            },
          }),
        );
      },
    });
    const entries = await backend.list();
    expect(entries).toEqual([{ path: 'Идея.md', etag: 'abc', mtime: Date.parse('2026-08-08T10:15:00Z'), size: 7 }]);
    const file = await backend.get('Идея.md');
    expect(fromUtf8(file?.data as Uint8Array)).toBe('# Идея\n');
  });

  it('истёкший токен даёт текст из реестра', async () => {
    const backend = new YandexDiskBackend({
      token: 'протух',
      fetch: async () => new Response('', { status: 401 }),
    });
    await expect(backend.list()).rejects.toThrow('Нужно снова войти в Яндекс.Диск');
  });

  it('падает обратно на WebDAV, если REST недоступен', async () => {
    let webdavUsed = false;
    const backend = new YandexDiskBackend({
      token: 'oauth',
      fetch: async (url, init) => {
        if (url.startsWith('https://webdav.yandex.ru')) {
          webdavUsed = true;
          return new Response('<d:multistatus xmlns:d="DAV:"></d:multistatus>', { status: 207 });
        }
        if (init?.method === 'PUT' || url.includes('resources?')) return new Response('', { status: 500 });
        return new Response('', { status: 500 });
      },
    });
    await backend.list();
    expect(webdavUsed).toBe(true);
  });
});

describe('ZapiskiCloudBackend (ADR-0003)', () => {
  it('эндпоинты соответствуют протоколу /api/v1/vault/*', () => {
    expect(API_PREFIX).toBe('/api/v1');
    expect(VAULT_ENDPOINTS.list).toBe('/api/v1/vault/list');
    expect(VAULT_ENDPOINTS.blob).toBe('/api/v1/vault/blob');
    expect(VAULT_ENDPOINTS.push).toBe('/api/v1/vault/push');
  });

  it('list и put используют токен и заголовок устройства', async () => {
    const seen: string[] = [];
    const backend = new ZapiskiCloudBackend({
      baseUrl: 'https://zapiski.cmpas.ru',
      token: 'jwt',
      deviceId: 'device-1',
      fetch: async (url, init) => {
        seen.push(url);
        expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt');
        expect((init?.headers as Record<string, string>)['X-Device-Id']).toBe('device-1');
        if (url.includes('/vault/list')) {
          return new Response(JSON.stringify({ entries: [{ path: 'Идея.md', etag: 'e1', mtime: 1, size: 2 }] }));
        }
        return new Response('', { status: 200, headers: { etag: '"e2"' } });
      },
    });
    expect(await backend.list()).toHaveLength(1);
    expect((await backend.put('Идея.md', utf8('x'), 'e1')).etag).toBe('e2');
    expect(seen[0]).toBe('https://zapiski.cmpas.ru/api/v1/vault/list');
  });

  it('истёкшая подписка сообщается текстом из реестра', async () => {
    const backend = new ZapiskiCloudBackend({
      token: 'jwt',
      deviceId: 'd',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'subscription_expired' } }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(backend.list()).rejects.toThrow('Подписка закончилась');
  });

  it('подписки не было — про конец не сообщаем', async () => {
    /* Дефект, который увидел заказчик: человек впервые вошёл, а продукт
       объявил конец подписки. Код 402 один на оба случая, различает их
       `code`, и текст обязан идти по нему. */
    const backend = new ZapiskiCloudBackend({
      token: 'jwt',
      deviceId: 'd',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'subscription_required' } }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(backend.list()).rejects.toThrow('входит в подписку');
  });

  it('402 без внятного тела не превращается в рассказ о конце подписки', async () => {
    /* Ответ без JSON — это неизвестность, а не «подписка кончилась». В
       неизвестности выбираем формулировку, которая не утверждает лишнего. */
    const backend = new ZapiskiCloudBackend({
      token: 'jwt',
      deviceId: 'd',
      fetch: async () => new Response('', { status: 402 }),
    });
    await expect(backend.list()).rejects.toThrow('входит в подписку');
  });

  it('push/pull CRDT-обновлений кодируются base64', async () => {
    const update = new Uint8Array([1, 2, 3, 4]);
    const backend = new ZapiskiCloudBackend({
      token: 'jwt',
      deviceId: 'd',
      fetch: async (url, init) => {
        if (url.includes('/vault/push')) {
          const body = JSON.parse(String(init?.body)) as { updates: Array<{ update: string }> };
          expect(body.updates[0]?.update).toBe(toBase64(update));
          return new Response(JSON.stringify({ accepted: 1, etags: {} }));
        }
        return new Response(JSON.stringify({ updates: [{ noteId: 'n1', update: toBase64(update) }] }));
      },
    });
    expect((await backend.pushUpdates([{ noteId: 'n1', update }])).accepted).toBe(1);
    const pulled = await backend.pullUpdates([{ noteId: 'n1', stateVector: new Uint8Array([9]) }]);
    expect(pulled[0]?.update).toEqual(update);
  });

  it('websocket-подписка отдаёт изменившиеся пути (BEHAVIOR §6)', () => {
    const handlers: Array<(event: { data: unknown }) => void> = [];
    const state = { closed: false };
    const backend = new ZapiskiCloudBackend({
      token: 'jwt',
      deviceId: 'd',
      fetch: async () => new Response(''),
      websocket: () => ({
        addEventListener: (_type: 'message', listener: (event: { data: unknown }) => void) => {
          handlers.push(listener);
        },
        close: () => {
          state.closed = true;
        },
      }),
    });
    const seen: string[] = [];
    const unsubscribe = backend.subscribe((path) => seen.push(path));
    handlers[0]?.({ data: JSON.stringify({ type: 'changed', path: 'Идея.md' }) });
    handlers[0]?.({ data: 'мусор' });
    expect(seen).toEqual(['Идея.md']);
    unsubscribe();
    expect(state.closed).toBe(true);
  });
});

describe('очередь изменений (ТЗ §4.3)', () => {
  it('переживает перезапуск и схлопывает повторы', async () => {
    const storage = new MemoryVaultStorage();
    const queue = new ChangeQueue(storage, () => 1);
    await queue.enqueue('Идея.md');
    await queue.enqueue('Идея.md');
    await queue.enqueue('План.md', 'delete');
    expect(queue.size).toBe(2);

    const restored = new ChangeQueue(storage, () => 2);
    await restored.load();
    expect(restored.size).toBe(2);
    expect(restored.list().map((item) => item.kind)).toContain('delete');

    await restored.done('Идея.md');
    expect(restored.has('Идея.md')).toBe(false);
    await restored.clear();
    expect(restored.size).toBe(0);
  });

  it('битый файл очереди не роняет запуск', async () => {
    const storage = new MemoryVaultStorage({ files: { '.zapiski/sync-queue.json': 'не json' } });
    const queue = new ChangeQueue(storage);
    await queue.load();
    expect(queue.size).toBe(0);
  });
});

describe('история версий (ТЗ §4.2)', () => {
  it('хранит не больше 50 снапшотов на заметку', async () => {
    const storage = new MemoryVaultStorage();
    let time = 0;
    const history = new VersionHistory(storage, () => (time += 1000));
    for (let i = 0; i < MAX_SNAPSHOTS + 10; i += 1) await history.push('n1', `версия ${i}`, 'Windows');
    const list = await history.list('n1');
    expect(list).toHaveLength(MAX_SNAPSHOTS);
    expect(list[0]?.body).toBe(`версия ${MAX_SNAPSHOTS + 9}`);
    expect(list[0]?.source).toBe('Windows');
  });

  it('не плодит дубликаты подряд и умеет чиститься при шифровании', async () => {
    const storage = new MemoryVaultStorage();
    const history = new VersionHistory(storage, () => Date.now());
    await history.push('n1', 'текст', 'local');
    await history.push('n1', 'текст', 'local');
    expect(await history.list('n1')).toHaveLength(1);

    const first = (await history.list('n1'))[0];
    expect(await history.get('n1', first?.id as string)).not.toBeNull();
    await history.clear('n1');
    expect(await history.list('n1')).toHaveLength(0);
  });
});

describe('движок синка: базовые сценарии', () => {
  it('выкладывает новые заметки и забирает чужие', async () => {
    const remote = new MemoryVaultStorage();
    const storage = new MemoryVaultStorage();
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    const engine = new SyncEngine(vault, new LocalFolderBackend(remote), { deviceName: 'Windows' });
    await engine.load();

    await vault.create({ title: 'Своя' });
    await engine.markChanged('Своя.md');
    await remote.write('Чужая.md', utf8('# Чужая\n'));

    const outcome = await engine.sync();
    expect(outcome.pushed).toBe(1);
    expect(outcome.pulled).toBe(1);
    expect(storage.snapshot()['Чужая.md']).toBe('# Чужая\n');
    expect(remote.snapshot()['Своя.md']).toContain('# Своя');
    expect(engine.status().lastSyncAt).not.toBeNull();
  });

  it('удаление локально удаляет и у контрагента', async () => {
    const remote = new MemoryVaultStorage();
    const storage = new MemoryVaultStorage();
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    const engine = new SyncEngine(vault, new LocalFolderBackend(remote), { deviceName: 'Windows' });
    await engine.load();

    await vault.create({ title: 'Временная' });
    await engine.markChanged('Временная.md');
    await engine.sync();
    expect(remote.snapshot()['Временная.md']).toBeDefined();

    await vault.trash('Временная.md');
    await engine.markDeleted('Временная.md');
    await engine.sync();
    expect(remote.snapshot()['Временная.md']).toBeUndefined();
  });

  it('ошибка синка не мешает работе и отдаёт текст из реестра', async () => {
    const remote = new MemoryVaultStorage();
    const storage = new MemoryVaultStorage();
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    const backend = new LocalFolderBackend(remote);
    backend.list = async () => {
      throw new SyncError('Сервер не отвечает · Повторить', 'unreachable');
    };
    /* Сети нет — только тогда слово «оффлайн» правдиво. */
    const engine = new SyncEngine(vault, backend, {
      deviceName: 'Windows',
      isOnline: () => false,
    });
    await engine.load();
    const outcome = await engine.sync();
    expect(outcome.state).toBe('offline');
    expect(outcome.messages).toContain('Оффлайн · всё сохранено локально');
  });

  it('сеть есть, а облако молчит — так и говорим, а не «оффлайн»', async () => {
    /*
     * Заказчик вошёл через Яндекс ID на телефоне с работающим интернетом и
     * увидел «Оффлайн · всё сохранено локально»: «фраза фрустрирует — я только
     * что вошёл, но пишет, что оффлайн». Слово уводило искать причину в
     * телефоне, а она была на сервере (он не пускал запросы приложения).
     */
    const remote = new MemoryVaultStorage();
    const storage = new MemoryVaultStorage();
    const vault = await Vault.open(storage, { renameDelayMs: 0 });
    const backend = new LocalFolderBackend(remote);
    backend.list = async () => {
      throw new SyncError('Сервер не отвечает · Повторить', 'unreachable');
    };
    const engine = new SyncEngine(vault, backend, {
      deviceName: 'Android',
      isOnline: () => true,
    });
    await engine.load();
    const outcome = await engine.sync();

    expect(outcome.messages).toContain('Не удалось соединиться с облаком · Повторить');
    expect(
      outcome.messages,
      'приложение снова объявляет оффлайн там, где сеть есть',
    ).not.toContain('Оффлайн · всё сохранено локально');
    expect(outcome.state).toBe('error');
  });
});
