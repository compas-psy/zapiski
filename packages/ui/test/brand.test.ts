/**
 * Сторож имени продукта в оболочках.
 *
 * DS-ALIGNMENT §9: продукт называется ЗАПИСКИ — без приставки, — семейство
 * СИМПАС, и «ни одной строки „КОМПАС“ в пользовательском интерфейсе».
 *
 * Почему сторож понадобился. Приёмка §11 этот пункт проверяла — но грепом по
 * строкам приложения, то есть по `packages/app` и `packages/ui`. Имя окна,
 * `productName`, `publisher` и `app_name` живут не там: они в нативных
 * манифестах оболочек, куда грep приёмки не заглядывал. В результате на живом
 * Windows в заголовке окна и в панели задач стояло «КОМПАС.ЗАПИСКИ» — отменённый
 * бренд доехал до пользователя, потому что проверяли текст, а не манифесты.
 *
 * Поэтому тест ходит по НАСТОЯЩИМ файлам `apps/**`, а не по списку известных
 * мест: список устаревает ровно тогда, когда появляется новый манифест, —
 * то есть в тот единственный момент, ради которого сторож и написан. Новый
 * файл в оболочке проверяется самим фактом своего существования.
 *
 * Границы обхода. Смотрим только `apps/**` — это оболочки, и это та
 * поверхность, где дефект возник. `docs/spec/**` (историческое ТЗ заказчика,
 * где старое имя законно), `server/**` и `deploy/**` в обход не попадают по
 * построению, а не списком исключений: сторож туда просто не ходит.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Корень монорепозитория: `packages/ui/test` → три уровня вверх. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SHELLS_DIR = resolve(REPO_ROOT, 'apps');

/**
 * Каталоги сборки и сгенерированного кода. Их содержимое не пишут руками:
 * `dist/` — собранный фронтенд, `target/` — артефакты Rust, `gen/` — проект
 * Gradle от `tauri android init`. Все они в `.gitignore`; старое имя там
 * означает лишь то, что сборка старше правки, и чинится пересборкой.
 */
const GENERATED = new Set(['node_modules', 'dist', 'build', 'target', 'gen', '.gradle']);

/** Двоичное — иконки, шрифты, ключи. Искать слова там нечего. */
const BINARY = new Set([
  '.png', '.ico', '.icns', '.jpg', '.jpeg', '.webp', '.gif',
  '.woff', '.woff2', '.ttf', '.otf',
  '.jar', '.keystore', '.jks', '.zip', '.apk', '.aab',
]);

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (GENERATED.has(entry)) continue;
      walk(full, found);
    } else if (!BINARY.has(extname(entry).toLowerCase())) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Отменённый бренд в двух написаниях.
 *
 *  • Кириллица — как в заголовке окна, `productName`, `publisher`, `app_name`.
 *  • Латиница — как в англоязычном каталоге: там стояло `KOMPAS.NOTES`.
 *    Регистр не важен: `Kompas.Notes` — тот же дефект другими буквами.
 *
 * Единственное исключение — `KompasCloud…`: так называется класс синка в
 * `packages/core/src/sync/kompas.ts`, и в оболочке он встречается ссылкой из
 * комментария. Это имя типа в коде, а не строка интерфейса; переименование
 * задевает ядро, сервер и документацию и делается отдельно. Исключение узкое
 * намеренно: `Kompas` в любом другом окружении сторож всё равно поймает.
 *
 * `cmpas` (домен `cmpas.ru`, `identifier` `ru.cmpas.zapiski`) под шаблон не
 * подходит и ловиться не должен: это адреса, а не имя в интерфейсе.
 */
const CYRILLIC = /КОМПАС/gi;
const LATIN = /kompas(?!Cloud)/gi;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function hits(pattern: RegExp): Hit[] {
  const found: Hit[] = [];
  for (const file of walk(SHELLS_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        found.push({ file: relative(REPO_ROOT, file), line: index + 1, text: text.trim() });
      }
    });
  }
  return found;
}

const report = (found: Hit[]): string[] =>
  found.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);

describe('отменённый бренд не вернулся в оболочки (DS-ALIGNMENT §9)', () => {
  it('обход вообще что-то нашёл — иначе сторож проверяет пустоту', () => {
    // Без этой проверки опечатка в пути превратила бы оба теста ниже в
    // зелёные навсегда: пустой список ничему не противоречит.
    const files = walk(SHELLS_DIR);
    expect(files.length).toBeGreaterThan(50);
    // Манифесты, из-за которых всё и случилось, обязаны быть в обходе.
    const seen = files.map((file) => relative(REPO_ROOT, file));
    for (const required of [
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/mobile/src-tauri/tauri.conf.json',
      'apps/mobile/android/app/src/main/res/values/strings.xml',
      'apps/mobile/android/app/src/main/res/values-en/strings.xml',
      'apps/desktop/index.html',
      'apps/web/index.html',
      'apps/mobile/index.html',
    ]) {
      expect(seen, `${required} выпал из обхода — сторож его больше не сторожит`).toContain(
        required,
      );
    }
  });

  it('ни одной «КОМПАС» в apps/**', () => {
    expect(
      report(hits(CYRILLIC)),
      'Отменённый бренд снова в оболочке. Продукт называется ЗАПИСКИ, ' +
        'семейство — СИМПАС (DS-ALIGNMENT §9).',
    ).toEqual([]);
  });

  it('ни одного «KOMPAS» в apps/**', () => {
    expect(
      report(hits(LATIN)),
      'Латинское написание отменённого бренда. В английском каталоге ' +
        'продукт — ZAPISKI (packages/app/src/i18n/en.ts, `brand.wordmark`).',
    ).toEqual([]);
  });

  it('сторож умеет краснеть: шаблоны ловят то, ради чего написаны', () => {
    // Ровно те строки, что стояли в живом приложении.
    const samples = [
      '<title>КОМПАС.ЗАПИСКИ</title>',
      '"productName": "КОМПАС.ЗАПИСКИ"',
      '"publisher": "КОМПАС"',
      '<string name="app_name">КОМПАС.ЗАПИСКИ</string>',
    ];
    for (const sample of samples) {
      CYRILLIC.lastIndex = 0;
      expect(CYRILLIC.test(sample), `${sample} проехал мимо сторожа`).toBe(true);
    }
    for (const sample of ["open: 'Open KOMPAS.NOTES'", "tooltip: 'Kompas.Notes'"]) {
      LATIN.lastIndex = 0;
      expect(LATIN.test(sample), `${sample} проехал мимо сторожа`).toBe(true);
    }
    // И не краснеет там, где краснеть не на что.
    for (const sample of [
      '/** Боевой KompasCloud. */',
      '"identifier": "ru.cmpas.zapiski"',
      'https://zapiski.cmpas.ru/api/v1',
      '<title>ЗАПИСКИ</title>',
    ]) {
      CYRILLIC.lastIndex = 0;
      LATIN.lastIndex = 0;
      expect(CYRILLIC.test(sample) || LATIN.test(sample), `${sample} — ложная тревога`).toBe(
        false,
      );
    }
  });
});

/**
 * Имя продукта не просто «не старое», а именно то, которое требует §9.
 * Без этого сторож выше был бы доволен и пустой строкой, и «Notes».
 */
describe('оболочки называются ЗАПИСКИ', () => {
  const conf = (app: string): Record<string, never> =>
    JSON.parse(readFileSync(resolve(SHELLS_DIR, app, 'src-tauri/tauri.conf.json'), 'utf8'));

  it('окно Windows и панель задач — «ЗАПИСКИ»', () => {
    const desktop = conf('desktop') as unknown as {
      productName: string;
      app: { windows: { title: string }[] };
      bundle: { publisher: string; copyright: string };
    };
    // Заголовок окна — то самое место, где дефект увидел пользователь.
    expect(desktop.app.windows[0]!.title).toBe('ЗАПИСКИ');
    // productName задаёт имя установщика, каталог установки и ключ реестра.
    expect(desktop.productName).toBe('ЗАПИСКИ');
    expect(desktop.bundle.publisher).toBe('СИМПАС');
    expect(desktop.bundle.copyright).toBe('СИМПАС');
  });

  it('издатель Android — СИМПАС', () => {
    const mobile = conf('mobile') as unknown as {
      identifier: string;
      bundle: { publisher: string; copyright: string };
    };
    expect(mobile.bundle.publisher).toBe('СИМПАС');
    expect(mobile.bundle.copyright).toBe('СИМПАС');
    // `identifier` — не имя, а личность приложения в Play. Смена после
    // публикации = новое приложение и потеря установок, поэтому он прибит
    // гвоздями и переживает любое переименование бренда.
    expect(
      mobile.identifier,
      'identifier Android менять нельзя: в Play это другое приложение.',
    ).toBe('ru.cmpas.zapiski');
  });

  it('имя в лаунчере и вкладке браузера — «ЗАПИСКИ»', () => {
    const strings = readFileSync(
      resolve(SHELLS_DIR, 'mobile/android/app/src/main/res/values/strings.xml'),
      'utf8',
    );
    expect(strings).toContain('<string name="app_name">ЗАПИСКИ</string>');

    const manifest = JSON.parse(
      readFileSync(resolve(SHELLS_DIR, 'web/public/manifest.webmanifest'), 'utf8'),
    ) as { name: string; short_name: string };
    expect(manifest.name).toBe('ЗАПИСКИ');
    expect(manifest.short_name).toBe('ЗАПИСКИ');

    for (const app of ['desktop', 'web', 'mobile']) {
      const html = readFileSync(resolve(SHELLS_DIR, app, 'index.html'), 'utf8');
      expect(html, `${app}/index.html: заголовок вкладки`).toContain('<title>ЗАПИСКИ</title>');
    }
  });
});
