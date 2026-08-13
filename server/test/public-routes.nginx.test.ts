/**
 * Публичные страницы API обязаны быть проведены через nginx.
 *
 * ── Дефект, ради которого этот файл написан ─────────────────────────────────
 *
 * API отдаёт не только `/api/...`. У него есть страницы, которые человек
 * открывает браузером по прямой ссылке: `/terms` и `/privacy` (их адрес стоит
 * у галочек согласия на экране входа) и `/p/:slug` (ссылка, которую человек
 * получает, опубликовав заметку).
 *
 * В vhost'е такие адреса нужны отдельными блоками. Без блока запрос доезжает
 * до SPA-фолбэка `location /` и открывается ПРИЛОЖЕНИЕ вместо документа. Это
 * не 404 и не ошибка: страница отвечает 200, показывает знакомый интерфейс — и
 * выглядит как «ссылка почему-то ведёт не туда». Для согласия это хуже всего:
 * галочка «принимаю условия» стоит рядом со ссылкой, которая условий не
 * показывает, а согласие, данное вслепую, согласием не является.
 *
 * Ровно так и было: маршрут `/p/:slug` жил в сервере с первой версии
 * публикации и не был проведён через nginx НИ РАЗУ.
 *
 * ── Почему проверка именно такая ────────────────────────────────────────────
 *
 * Список маршрутов берётся у настоящего собранного приложения, а не из руками
 * поддерживаемого перечня: перечень устаревает молча, а таблица маршрутов
 * Fastify — это то, что сервер действительно отвечает. База для этого не
 * нужна: маршруты регистрируются при сборке, а не при запросе.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadEnv } from '../src/config/env.ts';
import type { AppContext } from '../src/context.ts';
import { createPool } from '../src/db/pool.ts';
import { BlobStore } from '../src/services/blobStore.ts';
import { LiveBus } from '../src/services/liveBus.ts';
import { MemoryMailer } from '../src/services/mailer.ts';

const VHOST = path.resolve(
  fileURLToPath(new URL('../../deploy/zapiski.cmpas.ru.nginx.conf', import.meta.url)),
);

/** Адрес контейнера API внутри сервера — он же в docker-compose.yml. */
const API_UPSTREAM = 'http://127.0.0.1:3100';

/**
 * Маршруты, которым блок в vhost'е НЕ нужен, — с причиной у каждого.
 *
 * Список закрытый и сверяется на точное совпадение: новый публичный маршрут
 * обязан либо появиться в vhost'е, либо быть внесён сюда осознанно. Молча
 * «просто не попасть наружу» он не может.
 */
const NOT_EXPOSED: Record<string, string> = {
  /* Здоровьем API интересуется выкладка, и делает это через
     `/api/v1/health`, который наружу проведён. Второе, короткое имя того же
     эндпоинта снаружи не нужно вовсе. */
  '/health': 'дублируется как /api/v1/health',
  '/health/live': 'дублируется как /api/v1/health/live',
};

interface NginxLocation {
  /** Модификатор: '=', '^~', '~', '~*' или '' для простого префикса. */
  modifier: string;
  pattern: string;
  body: string;
}

/**
 * Разобрать vhost на location-блоки. Ищется ровно то, что нужно проверке:
 * модификатор, шаблон и тело блока (чтобы увидеть, куда он проксирует).
 */
export function parseLocations(conf: string): NginxLocation[] {
  const found: NginxLocation[] = [];
  const head = /location\s+(=|\^~|~\*|~)?\s*(\S+)\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = head.exec(conf)) !== null) {
    /* Тело — до парной закрывающей скобки, с учётом вложенных блоков:
       у `/updates/` внутри лежат ещё три location'а. */
    let depth = 1;
    let at = head.lastIndex;
    while (at < conf.length && depth > 0) {
      if (conf[at] === '{') depth += 1;
      else if (conf[at] === '}') depth -= 1;
      at += 1;
    }
    found.push({
      modifier: match[1] ?? '',
      pattern: match[2] ?? '',
      body: conf.slice(head.lastIndex, at - 1),
    });
  }
  return found;
}

/**
 * Разобрать дерево маршрутов Fastify в плоский список путей.
 *
 * `printRoutes` печатает дерево, где потомок — это ХВОСТ пути родителя
 * (`vault/` + `blob/` + `*`), а уровень вложенности кодируется четырьмя
 * символами отступа. Строки без списка методов — узлы дерева, а не маршруты.
 *
 * Дерево берётся с общими префиксами (по умолчанию), а не с `commonPrefix:
 * false`: в «плоском» виде Fastify печатает маршрут с шаблоном как одинокую
 * звёздочку без пути (`* (GET, PUT, DELETE)`), и восстановить, что это
 * `/api/v1/vault/blob/*`, уже нельзя.
 */
export function flattenRoutes(tree: string): string[] {
  const INDENT = new Set(['│   ', '    ', '├── ', '└── ']);
  const paths: string[] = [];
  const prefixes: string[] = [];

  for (const line of tree.split('\n')) {
    if (line.trim() === '') continue;
    let at = 0;
    let depth = 0;
    while (INDENT.has(line.slice(at, at + 4))) {
      depth += 1;
      at += 4;
    }
    const rest = line.slice(at);
    const methods = /\(([A-Z, ]+)\)\s*$/.exec(rest);
    const label = methods === null ? rest.trim() : rest.slice(0, methods.index).trim();
    const full = (depth > 0 ? (prefixes[depth - 1] ?? '') : '') + label;
    prefixes.length = depth;
    prefixes[depth] = full;
    if (methods !== null) paths.push(full);
  }
  return [...new Set(paths)];
}

/** Статическая часть пути: `/p/:slug` → `/p/`, `/terms` → `/terms`. */
function staticPart(route: string): string {
  const at = route.indexOf('/:');
  return at === -1 ? route : route.slice(0, at + 1);
}

/** Отдаёт ли блок этот адрес в API. */
function proxiesToApi(block: NginxLocation): boolean {
  return block.body.includes(`proxy_pass ${API_UPSTREAM}`);
}

/** Найти блок, который перехватит адрес РАНЬШЕ SPA-фолбэка. */
function coveringLocation(route: string, blocks: NginxLocation[]): NginxLocation | undefined {
  const target = staticPart(route);
  return blocks.find((block) => {
    if (block.modifier === '=') return block.pattern === target;
    /* `^~` обязателен для префикса: без него regex-блоки ниже (кэш ассетов,
       `\.html$`) выигрывают у простого префикса и уводят адрес не туда. */
    if (block.modifier === '^~') return target.startsWith(block.pattern);
    return false;
  });
}

describe('публичные страницы API проведены через nginx', () => {
  let app: FastifyInstance;
  let blobRoot: string;
  let routes: string[];
  let blocks: NginxLocation[];

  beforeAll(async () => {
    blobRoot = await mkdtemp(path.join(tmpdir(), 'zapiski-routes-'));
    /* База не нужна: маршруты регистрируются при сборке приложения. Пул
       создаётся лениво и ни одного запроса здесь не делает. */
    const ctx: AppContext = {
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://unused/unused',
        AUTH_SECRET: 'x'.repeat(40),
        BLOB_ROOT: blobRoot,
        LOG_LEVEL: 'silent',
      } as NodeJS.ProcessEnv),
      db: createPool('postgres://unused/unused', 1),
      blobs: new BlobStore(blobRoot),
      mailer: new MemoryMailer(),
      live: new LiveBus(),
      yandex: null,
      play: null,
      retention: { trialDays: 7, paidDays: 90 },
      now: () => new Date(),
    };
    app = await buildApp(ctx);
    await app.ready();

    routes = flattenRoutes(app.printRoutes()).filter((route) => !route.startsWith('/api/'));
    blocks = parseLocations(await readFile(VHOST, 'utf8'));
  });

  afterAll(async () => {
    await app?.close();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('разбор сам себя не обманывает', () => {
    /* Если бы разбор молча возвращал пустоту, проверки ниже прошли бы, ничего
       не проверив. Поэтому сперва — что разобрано хоть что-то осмысленное. */
    expect(routes.length, 'публичных маршрутов не нашлось вовсе').toBeGreaterThan(0);
    expect(routes, 'страницы соглашения нет в таблице маршрутов').toContain('/terms');
    expect(blocks.length, 'в vhost не нашлось ни одного location').toBeGreaterThan(5);
    expect(
      blocks.some((block) => block.modifier === '' && block.pattern === '/'),
      'в vhost не нашёлся SPA-фолбэк — значит разбор блоков сломан',
    ).toBe(true);
  });

  it('каждый публичный адрес перехватывается раньше SPA-фолбэка', () => {
    const missing = routes
      .filter((route) => NOT_EXPOSED[route] === undefined)
      .filter((route) => coveringLocation(route, blocks) === undefined);

    expect(
      missing,
      `в deploy/zapiski.cmpas.ru.nginx.conf нет блока для: ${missing.join(', ')} — ` +
        'такой адрес откроет приложение вместо документа',
    ).toEqual([]);
  });

  it('перехваченные адреса ведут в API, а не в статику', () => {
    const wrong = routes
      .filter((route) => NOT_EXPOSED[route] === undefined)
      .filter((route) => {
        const block = coveringLocation(route, blocks);
        return block !== undefined && !proxiesToApi(block);
      });

    expect(wrong, `блок есть, но не проксирует в API: ${wrong.join(', ')}`).toEqual([]);
  });

  it('выкладка узнаёт документ по признаку, который на странице есть', async () => {
    /* `verify_documents` в deploy/deploy-production-remote.sh отличает
       настоящий документ от SPA-фолбэка по обёртке `<main class="sheet">`:
       кода 200 недостаточно, index.html отдаётся с ним же.
       Признак живёт в двух файлах сразу, поэтому сверяются оба — иначе
       переименование класса сделало бы проверку выкладки слепой, и она
       рапортовала бы «документ на месте» об экране приложения. */
    const marker = '<main class="sheet">';
    const page = await app.inject({ method: 'GET', url: '/terms' });

    expect(page.statusCode).toBe(200);
    expect(page.body, 'страница соглашения потеряла признак документа').toContain(marker);

    const deployScript = await readFile(
      path.resolve(fileURLToPath(new URL('../../deploy/deploy-production-remote.sh', import.meta.url))),
      'utf8',
    );
    expect(
      deployScript.includes(marker),
      'выкладка ищет на странице другой признак — проверка документов ослепла',
    ).toBe(true);
  });

  it('тексты документов попадают в образ, из которого их читают', async () => {
    /* Страницы `/terms` и `/privacy` читают markdown С ДИСКА на каждый запрос —
       нарочно, чтобы правку текста можно было выкатить без пересборки
       клиентов. Значит каталог обязан оказаться в рантайм-образе.
       Не оказался: образ копировал dist, src и migrations, а legal — нет.
       Снаружи это выглядело как «nginx довёл запрос до API, а тот ответил
       404 на собственном документе». */
    const dockerfile = await readFile(
      path.resolve(fileURLToPath(new URL('../../deploy/api.Dockerfile', import.meta.url))),
      'utf8',
    );
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));

    expect(
      /^COPY\s+legal\s+\.\/legal\s*$/m.test(runtime),
      'в рантайм-образ не копируется server/legal — документы согласия ответят 404',
    ).toBe(true);
  });

  it('список непроведённых маршрутов закрыт и осознан', () => {
    /* Не «пусть незакрытое просто не попадёт наружу»: каждый такой маршрут
       назван поимённо, и новый публичный адрес обязан заставить принять
       решение, а не тихо остаться недоступным. */
    const unexposed = routes.filter((route) => coveringLocation(route, blocks) === undefined);
    expect(unexposed.sort()).toEqual(Object.keys(NOT_EXPOSED).sort());
  });
});
