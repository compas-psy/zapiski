/**
 * Сторож слоя дизайн-системы.
 *
 * Две вещи, которые ломаются молча и обнаруживаются только на проде:
 *
 *  1. Шрифт из сети. `simpas/vendor/tokens/fonts.css` тянет Geist через
 *     `@import url("https://fonts.googleapis.com/…")`. Каталог `vendor/` —
 *     побайтовая копия системы, править его нельзя, поэтому наш
 *     `simpas-offline.css` повторяет список импортов системы БЕЗ этого файла и
 *     подставляет self-hosted `fonts.css`. Требование DESIGN_TOKENS §2: ни
 *     одного обращения к CDN в рантайме — приложение работает офлайн, а в
 *     Tauri внешний CDN вообще недоступен.
 *
 *  2. Дрейф списка. Если система добавит или переименует файл токенов, наш
 *     список молча отстанет и часть переменных пропадёт. Тест сверяет его с
 *     `vendor/styles.css` — единственная допустимая разница — `fonts.css`.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readImports, SIMPAS_ENTRY_PATH, SIMPAS_VENDOR_ENTRY_PATH, STYLES_DIR } from './tokens';

const INDEX_PATH = resolve(STYLES_DIR, 'index.css');

/** Обходит граф `@import` от точки входа, возвращает абсолютные пути файлов. */
function collectGraph(entry: string, seen = new Set<string>()): string[] {
  if (seen.has(entry)) return [];
  seen.add(entry);
  const files = [entry];
  for (const relativePath of readImports(entry)) {
    if (/^[a-z]+:/i.test(relativePath)) {
      files.push(relativePath); // внешний URL — попадёт в проверку ниже
      continue;
    }
    files.push(...collectGraph(resolve(dirname(entry), relativePath), seen));
  }
  return files;
}

describe('слой СИМПАСА подключён без сети', () => {
  it('из графа стилей пакета не торчит ни одного внешнего импорта', () => {
    const remote = collectGraph(INDEX_PATH).filter((file) => /^[a-z]+:/i.test(file));
    expect(
      remote,
      'Внешний @import в графе styles/index.css: шрифт или токены поедут с CDN, ' +
        'а приложение обязано работать офлайн (DESIGN_TOKENS §2).',
    ).toEqual([]);
  });

  it('в графе есть self-hosted fonts.css, и он ссылается только на ../fonts/', () => {
    const graph = collectGraph(INDEX_PATH);
    const fonts = graph.find((file) => file.endsWith(`${'fonts'}.css`) && !file.includes('vendor'));
    expect(fonts, 'self-hosted fonts.css не подключён').toBeDefined();

    const css = readFileSync(fonts!, 'utf8');
    const sources = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source, `${source} — не локальный файл шрифта`).toMatch(/^\.\.\/fonts\/[\w-]+\.woff2$/);
    }
    /* DS-ALIGNMENT §6: интерфейс — Geist, моно — Geist Mono. */
    expect(css).toContain("font-family: 'Geist'");
    expect(css).toContain("font-family: 'Geist Mono'");
  });

  it('vendor остаётся нетронутым — CDN-импорт там на месте', () => {
    /* Если этот тест упал, кто-то отредактировал побайтовую копию системы.
       Чинить надо не vendor, а наш слой. */
    const fontsCss = readFileSync(
      resolve(dirname(SIMPAS_VENDOR_ENTRY_PATH), 'tokens/fonts.css'),
      'utf8',
    );
    expect(fontsCss).toContain('fonts.googleapis.com');
  });
});

describe('список токенов системы не разошёлся со снимком', () => {
  it('simpas-offline.css повторяет vendor/styles.css минус fonts.css', () => {
    const vendorFiles = readImports(SIMPAS_VENDOR_ENTRY_PATH)
      .map((path) => basename(path))
      .filter((name) => name !== 'fonts.css');

    const ourFiles = readImports(SIMPAS_ENTRY_PATH)
      .filter((path) => path.includes('/vendor/'))
      .map((path) => basename(path));

    expect(
      ourFiles,
      'Список токенов системы разошёлся со снимком. Обновите simpas-offline.css: ' +
        'он обязан подключать всё, что подключает vendor/styles.css, кроме fonts.css.',
    ).toEqual(vendorFiles);
  });

  it('цвета сервисов подключены — терракота приходит только оттуда', () => {
    const ourFiles = readImports(SIMPAS_ENTRY_PATH);
    expect(ourFiles).toContain('./simpas/services.css');
  });
});

/**
 * Подсветка нажатия — та, что нарисовали мы, а не WebView.
 *
 * Найдено на живом Android: карточки онбординга при касании заливались
 * полупрозрачной бирюзой. Это подсветка WebView по умолчанию, и цвета этого
 * нет ни в одном нашем токене — посреди зелёно-кремовой палитры вспыхивал
 * чужой. На тёмной теме особенно заметно.
 *
 * Гасить её нужно один раз в корне: у кнопок это уже было сделано в их
 * собственных стилях, у карточек — нет, и разница вылезла ровно там.
 */
describe('подсветка нажатия принадлежит нам', () => {
  const base = readFileSync(resolve(STYLES_DIR, 'base.css'), 'utf8');

  it('системная подсветка WebView погашена в корне', () => {
    // Именно в `:root`: правило наследуется, и одного объявления хватает на
    // всё дерево. Гасить его в каждом компоненте — значит однажды забыть.
    const root = base.slice(base.indexOf(':root {'), base.indexOf('body {'));
    expect(root).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
  });

  it('взамен есть своё состояние: карточка отзывается на касание', () => {
    // Убрать чужую подсветку и не дать своей — значит сделать хуже: на
    // касание перестанет отвечать вообще что-либо.
    // Карточки живут в @zapiski/app: стили экранов там, а не в дизайн-системе.
    const app = readFileSync(
      resolve(STYLES_DIR, '../../../app/src/styles/app.css'),
      'utf8',
    );
    const press = /\.za-card:active\s*\{[^}]*transform:\s*scale\(var\(--press-scale\)\)/;
    expect(app).toMatch(press);
  });
});

/**
 * Наведение не должно прилипать на тач-устройстве.
 *
 * На живом Android основная кнопка стояла в hover-цвете постоянно: замер
 * пикселя дал #539A6D при `--accent` = #3B8F5A (DS-ALIGNMENT §5). Разница
 * ровно на `--accent-hover`. Причина не в цвете, а в том, что браузер
 * применяет `:hover` к последнему тронутому элементу и не снимает его.
 *
 * Понять это по коду было нельзя — только по пикселю с устройства. Поэтому
 * правило теперь стережётся тестом: каждое `:hover` в наших стилях живёт под
 * `@media (hover: hover)`.
 */
describe('наведение не прилипает на тач', () => {
  /** Наши стили. Снимок системы не наш — его правит владелец, не мы. */
  const OURS = [
    'components/Button/Button.css',
    'components/Chip/Chip.css',
    'components/Field/Field.css',
    'components/List/List.css',
    'components/Special/Special.css',
  ];

  function unguardedHovers(source: string): string[] {
    // Комментарии выбрасываем: упоминание `:hover` в объяснении — не правило.
    // Перевод строки вместо пустой строки, чтобы номера строк не съезжали.
    const css = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
      block.replace(/[^\n]/g, ' '),
    );
    const lines = css.split('\n');
    const bad: string[] = [];
    let depth = 0;
    let guarded: number | null = null;
    for (const line of lines) {
      if (/@media[^{]*\(hover:\s*hover\)/.test(line)) guarded = depth;
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      if (/:hover/.test(line) && !/@media/.test(line) && guarded === null) {
        bad.push(line.trim());
      }
      depth += opens - closes;
      if (guarded !== null && depth <= guarded) guarded = null;
    }
    return bad;
  }

  for (const file of OURS) {
    it(`${file}: ни одного незащищённого :hover`, () => {
      const css = readFileSync(resolve(STYLES_DIR, '..', file), 'utf8');
      expect(unguardedHovers(css)).toEqual([]);
    });
  }

  it('стили экранов приложения — тоже', () => {
    const css = readFileSync(resolve(STYLES_DIR, '../../../app/src/styles/app.css'), 'utf8');
    expect(unguardedHovers(css)).toEqual([]);
  });

  it('сторож работает: подсунутый незащищённый :hover находится', () => {
    // Без этой проверки тест выше мог бы молча ничего не проверять.
    expect(unguardedHovers('.x:hover { color: red; }')).toHaveLength(1);
    expect(unguardedHovers('@media (hover: hover) {\n.x:hover { color: red; }\n}')).toHaveLength(0);
  });
});
