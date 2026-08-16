/**
 * Крошечный статический сервер для браузерных проверок.
 *
 * Зачем свой, когда есть `npx serve`. Во-первых, `npx` тянет пакет из сети, а
 * проверки обязаны работать и без неё — иначе они молча пропускаются ровно
 * тогда, когда нужнее всего. Во-вторых, и это важнее: когда сервер не
 * поднимался, проверки не говорили «сервера нет». Они открывали пустую
 * страницу и рапортовали «51 расхождение токенов» — то есть врали о причине,
 * а починить по такому отчёту нельзя ничего.
 *
 * Отсюда второе правило этого модуля: `serveDist` не возвращает управление,
 * пока не убедится, что отдаёт `index.html`. Не смогла — падение с внятным
 * текстом, а не тихая пустая страница.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

/** Типы, которые нужны собранному PWA. Остальное отдаём потоком байтов. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * Поднимает статику `root` на `port`.
 *
 * Приложение одностраничное, поэтому любой неизвестный путь отдаёт
 * `index.html`: маршруты разбирает оно само.
 *
 * @returns {Promise<{ url: string, close: () => void }>}
 */
export async function serveDist(root, port) {
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`нет собранной статики ${index} — сначала соберите PWA`);
  }

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    let file = join(root, path === '/' ? 'index.html' : path.slice(1));
    /* Каталог — не файл: отдаём его `index.html`, как это делает nginx
       (`try_files $uri $uri/`). Без этой ветки `/promo` уходил в `readFileSync`
       каталога, тот бросал EISDIR уже ПОСЛЕ отправки заголовков, и вместо
       страницы прогон получал «Cannot write headers after they are sent». */
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) || file.endsWith('/')) file = index;
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  const url = `http://127.0.0.1:${port}/`;

  /** Отдаёт ли по адресу именно наша собранная страница. */
  const ours = async () => {
    const probe = await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (!probe?.ok) return false;
    return (await probe.text().catch(() => '')).includes('<div id="root"');
  };

  const listening = await new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(Number(port), '127.0.0.1', () => resolve(true));
  });

  /* Порт занят — это ещё не беда: там может стоять уже поднятая статика
     (`pnpm dev`, соседняя проверка). Но убедиться, что это НАША страница,
     обязательно: иначе проверки молча измерят чужой сайт. */
  if (!listening) {
    if (await ours()) return { url, close: () => {} };
    throw new Error(`порт ${port} занят чем-то другим — проверять нечего`);
  }

  if (!(await ours())) {
    server.close();
    throw new Error(`статика на ${url} не отдаёт index.html — проверять нечего`);
  }

  return { url, close: () => server.close() };
}
