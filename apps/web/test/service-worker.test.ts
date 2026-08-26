/**
 * Service worker: чего он НЕ должен делать.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * «На Android письмо приходит, но после перехода по ссылке опять уводит на
 * промо». На вопрос, что именно на экране, — «промо-страница со ссылками на
 * скачивание». Ссылку просили из приложения на Android.
 *
 * ── Почему это оказался воркер, а не сервер ─────────────────────────────────
 *
 * Сервер проверен отдельно и на живом сокете: при `platform=android` он
 * отдаёт страницу с переходом в `zapiski://`, а не редирект на сайт. Значит
 * до сервера дело не дошло. Дойти ему помешал воркер, и сразу двумя способами.
 *
 *  1. Он перехватывал переход по ссылке из письма и уводил его в
 *     веб-приложение. Правило заводилось, когда сервер ждал `device_id`
 *     отдельно; потом сервер стал класть его в саму ссылку, а правило
 *     осталось. Воркер живёт на ВЕСЬ домен — и забирал себе ссылки, которые
 *     просило приложение.
 *
 *  2. Он сохранял под ключом оболочки ответ на ЛЮБОЙ переход. На домене
 *     лежат и обычные страницы: /promo, /terms, /privacy. Достаточно было
 *     один раз открыть промостраницу — скачать APK, например, — и дальше
 *     любой переход, отвеченный из кэша, показывал промо.
 *
 * ── Почему проверка такая ───────────────────────────────────────────────────
 *
 * Поднимается НАСТОЯЩИЙ `public/sw.js` — тот файл, который уезжает на сервер.
 * Копии его логики здесь нет: копия разошлась бы с оригиналом, а дефект был
 * ровно в оригинале. Подменены только `caches` и `fetch`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

const SW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/sw.js');
const ORIGIN = 'https://zapiski.cmpas.ru';

/** Подделка `Cache` — ровно те методы, которыми пользуется воркер. */
class FakeCache {
  readonly entries = new Map<string, string>();
  async match(key: string | { url: string }): Promise<Response | undefined> {
    const url = typeof key === 'string' ? key : key.url;
    const body = this.entries.get(new URL(url, ORIGIN).pathname);
    return body === undefined ? undefined : new Response(body);
  }
  async put(key: string | { url: string }, value: Response): Promise<void> {
    const url = typeof key === 'string' ? key : key.url;
    this.entries.set(new URL(url, ORIGIN).pathname, await value.text());
  }
  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.entries.set(new URL(url, ORIGIN).pathname, `сеть:${url}`);
  }
}

interface Harness {
  /** Что вернул воркер на переход, либо null — «пропустил в сеть». */
  navigate(pathname: string, body?: string): Promise<Response | null>;
  shell(): string | undefined;
  caches: Map<string, FakeCache>;
}

/** Загружает настоящий sw.js в поддельное окружение воркера. */
function loadWorker(): Harness {
  const source = readFileSync(SW, 'utf8');
  const stores = new Map<string, FakeCache>();
  const listeners = new Map<string, (event: unknown) => void>();

  const cachesApi = {
    open: async (name: string): Promise<FakeCache> => {
      const existing = stores.get(name);
      if (existing !== undefined) return existing;
      const fresh = new FakeCache();
      stores.set(name, fresh);
      return fresh;
    },
    keys: async (): Promise<string[]> => [...stores.keys()],
    delete: async (name: string): Promise<boolean> => stores.delete(name),
  };

  /* Сеть отвечает содержимым, зависящим от адреса: так видно, ЧТО осело в
     кэше — оболочка или посторонняя страница. */
  const fetchImpl = async (input: string | { url: string }): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    const { pathname } = new URL(url, ORIGIN);
    return new Response(`сеть:${pathname}`, { status: 200 });
  };

  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      listeners.set(name, handler);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'caches', 'fetch', 'Response', 'URL', 'Date', source)(
    scope,
    cachesApi,
    fetchImpl,
    Response,
    URL,
    Date,
  );

  const install = listeners.get('install');
  const fetchHandler = listeners.get('fetch');
  if (install === undefined || fetchHandler === undefined) {
    throw new Error('воркер не подписался на install/fetch — проверка бессмысленна');
  }

  const waits: Promise<unknown>[] = [];
  install({ waitUntil: (p: Promise<unknown>) => waits.push(p) });

  return {
    caches: stores,
    /* Кэш ищется по назначению, а не по имени с версией: имя меняется, и
       сторож, привязанный к нему, вместо честного «оболочка подменена»
       ругался бы на `undefined` — то есть врал бы о причине. */
    shell: () => {
      for (const [name, store] of stores) {
        if (name.includes('shell')) return store.entries.get('/notes/index.html');
      }
      return undefined;
    },
    async navigate(pathname: string): Promise<Response | null> {
      await Promise.all(waits.splice(0));
      let answer: Promise<Response> | null = null;
      fetchHandler({
        request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}${pathname}` },
        respondWith: (p: Promise<Response>) => {
          answer = p;
        },
      });
      /* Воркер обновляет оболочку фоном (`void refreshShell()`) — даём
         микрозадачам доиграть, иначе проверка увидит вчерашний кэш. */
      await new Promise((resolve) => setTimeout(resolve, 0));
      return answer === null ? null : await (answer as Promise<Response>);
    },
  };
}

let worker: Harness;
beforeEach(() => {
  worker = loadWorker();
});

describe('ссылка из письма достаётся серверу, а не воркеру', () => {
  it('переход по ссылке из письма воркер пропускает в сеть', async () => {
    /*
     * `null` здесь означает «воркер не позвал respondWith», то есть браузер
     * идёт в сеть сам. Только так сервер сможет решить по платформе, вернуть
     * человека в приложение или в браузер. Раньше воркер отвечал редиректом
     * на /auth/callback — и вход из приложения на Android не замыкался.
     */
    const answer = await worker.navigate('/api/v1/auth/magic-link/callback?token=t&device_id=dev-1');
    expect(answer, 'воркер снова забрал ссылку из письма себе').toBeNull();
  });

  it('прочие запросы к API воркер тоже не трогает', async () => {
    expect(await worker.navigate('/api/v1/health')).toBeNull();
  });
});

describe('оболочку кэширует только оболочка', () => {
  it('открытая промостраница не становится оболочкой приложения', async () => {
    const promo = await worker.navigate('/promo');
    expect(await promo?.text()).toBe('сеть:/promo');
    /* Вот он, дефект: под ключом оболочки оказывалось «сеть:/promo», и дальше
       любой переход из кэша показывал промо. */
    expect(worker.shell(), 'промостраница подменила собой оболочку').not.toContain('/promo');
  });

  it('и правовые страницы тоже не становятся', async () => {
    await worker.navigate('/terms');
    await worker.navigate('/privacy');
    expect(worker.shell()).not.toContain('/terms');
    expect(worker.shell()).not.toContain('/privacy');
  });

  it('корень домена — теперь промо, а не приложение — тоже не становится оболочкой', async () => {
    /* / отдан промо-странице (решение учредителя): переход по корню — обычная
       навигация, как /promo, и не должен подменить собой /notes/index.html. */
    const root = await worker.navigate('/');
    expect(await root?.text()).toBe('сеть:/');
    expect(worker.shell(), 'корень подменил собой оболочку').not.toBe('сеть:/');
  });

  it('в кэше оболочки лежит именно оболочка приложения на /notes/', async () => {
    await worker.navigate('/promo');
    expect(worker.shell()).toContain('/notes/index.html');
  });
});

describe('возврат после входа остаётся маршрутом приложения', () => {
  it('/auth/callback отвечается оболочкой, не спрашивая сеть', async () => {
    const answer = await worker.navigate('/auth/callback#access_token=x');
    expect(answer, 'возврат после входа ушёл в сеть — статика ответит 404').not.toBeNull();
    expect(await answer?.text()).toContain('/notes/index.html');
  });

  it('после открытой промостраницы возврат всё равно даёт оболочку', async () => {
    /* Тот самый сценарий заказчика: сначала промостраница (скачать APK),
       потом переход по ссылке из письма. */
    await worker.navigate('/promo');
    const answer = await worker.navigate('/auth/callback#access_token=x');
    expect(await answer?.text(), 'после промостраницы вход показывает промо').not.toContain('/promo');
  });
});

describe('отравленный кэш выбрасывается с устройств', () => {
  it('имя кэша не совпадает с тем, в котором лежит промостраница', () => {
    /*
     * У заказчика на телефоне в кэше `zapiski-shell-v1` под ключом оболочки
     * лежит промостраница. Починка кода её оттуда не достаёт: воркер читает
     * кэш по имени. Достаёт только переименование — `activate` удаляет всё,
     * чего нет в `keep`.
     *
     * Поэтому имя v1 запрещено навсегда, а не «до следующей версии».
     */
    const source = readFileSync(SW, 'utf8');
    expect(source, 'кэш снова назван v1 — на устройствах останется промо').not.toContain(
      "const VERSION = 'v1'",
    );
    expect(source, 'версия кэша исчезла вовсе').toMatch(/const VERSION = '\w+';/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Воркер должен уметь заменяться
// ─────────────────────────────────────────────────────────────────────────────

describe('новый воркер доезжает до устройств', () => {
  const vhost = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/zapiski.cmpas.ru.nginx.conf'),
    'utf8',
  );

  it('sw.js отдаётся без кэша', () => {
    /*
     * Инвариант с самой высокой ценой ошибки во всей статике.
     *
     * Воркер перехватывает переходы на ВЕСЬ домен. Если он однажды сломается —
     * а он ломался, и вход на Android из-за этого не работал, — починка
     * доедет до человека только тем, что браузер перечитает `/sw.js`.
     * Поставить сюда долгий срок жизни значит запереть каждое устройство на
     * сломанной версии, и никакая выкладка этого уже не исправит.
     *
     * Браузеры и сами перечитывают воркер, но не чаще суток и не всегда.
     * Полагаться на это нельзя: сутки простоя входа — не «мелочь кэша».
     */
    const block = /location = \/sw\.js \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'в vhost нет блока для /sw.js').not.toBe('');
    expect(block, 'воркер стал кэшироваться — починка не доедет до устройств').toMatch(
      /Cache-Control\s+"no-cache/,
    );
    expect(block).toContain('no-store');
  });

  it('воркер забирает управление сразу, а не со следующего запуска', () => {
    /* Без `skipWaiting` новый воркер ждёт, пока закроются все вкладки со
       старым. На телефоне вкладку не закрывают неделями. */
    const source = readFileSync(SW, 'utf8');
    expect(source).toContain('skipWaiting');
    expect(source).toContain('clients.claim');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Корень домена — промо, приложение — /notes/ (решение учредителя)
// ─────────────────────────────────────────────────────────────────────────────
//
// Сервис ещё не выпущен, откатывать установленные PWA не для кого — поэтому
// перенос делается одним заходом. Но развязка у него та же, что у любой
// живущей на весь домен статики: физический /index.html и /assets/* остаются
// на месте (Vite не переносит их сборкой — так уже проверено настоящей
// сборкой), а /notes/* — это ЛОГИЧЕСКИЙ адрес, который nginx обязан довести до
// тех же файлов. Расхождение здесь — это 404 на каждый JS и CSS в проде.

describe('sw.js знает новый адрес оболочки', () => {
  it('SHELL_URL указывает на /notes/index.html, а не на корень', () => {
    const source = readFileSync(SW, 'utf8');
    expect(source, 'оболочка всё ещё ищется в корне — корень теперь промо').toContain(
      "const SHELL_URL = '/notes/index.html'",
    );
  });

  it('корень домена не входит в список предзагрузки install', () => {
    /* «/» раньше был оболочкой и предзагружался install'ом. Теперь там
       промо — предзагружать его в кэш ОБОЛОЧКИ значит однажды случайно
       отдать его как fallback приложения. */
    const source = readFileSync(SW, 'utf8');
    const install = /self\.addEventListener\('install',[\s\S]*?\n\}\);/.exec(source)?.[0] ?? '';
    expect(install, 'install-обработчик не найден').not.toBe('');
    expect(install, 'корень «/» всё ещё в списке предзагрузки оболочки').not.toMatch(/addAll\(\['\/'/);
  });

  it('хешированные ассеты кэшируются по новому префиксу /notes/assets/', () => {
    const source = readFileSync(SW, 'utf8');
    expect(source, 'проверка ассетов ещё смотрит на голый /assets/').toContain(
      "url.pathname.startsWith('/notes/assets/')",
    );
  });
});

describe('nginx: корень — промо, /notes/ — приложение, /auth — по-прежнему приложение', () => {
  const vhost = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../deploy/zapiski.cmpas.ru.nginx.conf'),
    'utf8',
  );

  it('точный «/» отдаёт промо, а не приложение', () => {
    const block = /location = \/ \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'в vhost нет отдельного точного блока для «/»').not.toBe('');
    expect(block, 'корень отдаёт не промо').toMatch(/promo\/index\.html/);
  });

  it('общий SPA-фолбэк тоже ведёт на промо, а не на приложение', () => {
    const block = /\n    location \/ \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'в vhost нет общего блока location /').not.toBe('');
    expect(block, 'случайный адрес всё ещё падает в приложение').toMatch(/promo\/index\.html/);
  });

  it('/notes отдаёт оболочку приложения', () => {
    expect(vhost, 'нет location для /notes').toMatch(/location \/notes \{/);
    const block = /location \/notes \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'блок /notes не фолбэчится на index.html приложения').toMatch(
      /\/index\.html/,
    );
  });

  it('/notes/assets/ доезжает до настоящих файлов в /assets/', () => {
    const block = /location \^~ \/notes\/assets\/ \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'нет блока для /notes/assets/ — сборка станет пустой страницей без JS').not.toBe(
      '',
    );
    expect(block, 'ассеты не перенаправлены на настоящий физический путь').toMatch(
      /\/assets\/\$1/,
    );
  });

  it('/notes/manifest.webmanifest доезжает до настоящего манифеста', () => {
    const block = /location = \/notes\/manifest\.webmanifest \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'нет блока для /notes/manifest.webmanifest').not.toBe('');
    expect(block).toMatch(/\/manifest\.webmanifest/);
  });

  it('/auth по-прежнему резолвится в приложение, а не в промо', () => {
    /* Свежий /auth не проверяет только корневой фолбэк: раньше он падал в
       общий location / (тогда — приложение), и после переноса промо на
       корень тот же общий блок увёл бы возврат после входа на промо. */
    const block = /location \^~ \/auth \{([^}]*)\}/.exec(vhost)?.[1] ?? '';
    expect(block, 'нет отдельного блока для /auth — попадёт в промо-фолбэк').not.toBe('');
    expect(block).toMatch(/\/index\.html/);
  });
});
