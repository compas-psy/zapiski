/**
 * Сторож стилевого слоя.
 *
 * Три вещи, которые ломаются молча и обнаруживаются только на живом
 * устройстве.
 *
 *  1. Шрифт из сети. Требование tz/ZAPISKI_TZ_2_Engineering.md §10 и самого
 *     принципа local-first: приложение обязано работать в самолёте, а в
 *     Tauri-сборке внешний CDN просто недоступен. Раньше эту дыру приносил
 *     `@import url("https://fonts.googleapis.com/…")` из чужой дизайн-системы;
 *     системы больше нет, но проверка остаётся — она про граф импортов, а не
 *     про конкретного виновника.
 *
 *  2. Токены мимо источника. `tokens.generated.css` собирается из
 *     `design/tokens.json` (мост «дизайн → код», tz/…_3_Agents.md §6). Правка
 *     прямо в CSS выглядит работающей и переживает ровно до следующей
 *     генерации, поэтому сверка идёт с источником.
 *
 *  3. Подсветка и наведение из WebView — см. соответствующие блоки ниже.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readImports, STYLES_DIR, STYLES_ENTRY_PATH } from './tokens';

const REPO_ROOT = resolve(STYLES_DIR, '../../../..');

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

describe('стилевой слой подключён без сети', () => {
  it('из графа стилей пакета не торчит ни одного внешнего импорта', () => {
    const remote = collectGraph(STYLES_ENTRY_PATH).filter((file) => /^[a-z]+:/i.test(file));
    expect(
      remote,
      'Внешний @import в графе styles/index.css: шрифт или токены поедут с CDN, ' +
        'а приложение обязано работать офлайн.',
    ).toEqual([]);
  });

  it('в графе есть self-hosted fonts.css, и он ссылается только на ../fonts/', () => {
    const graph = collectGraph(STYLES_ENTRY_PATH);
    const fonts = graph.find((file) => file.endsWith('fonts.css'));
    expect(fonts, 'self-hosted fonts.css не подключён').toBeDefined();

    const css = readFileSync(fonts!, 'utf8');
    const sources = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]!);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source, `${source} — не локальный файл шрифта`).toMatch(/^\.\.\/fonts\/[\w-]+\.woff2$/);
    }
  });

  it('гарнитуры — те, что назвало ТЗ: Golos Text, Source Serif 4, JetBrains Mono', () => {
    // Проверяется именно @font-face, а не --font-sans: объявить семейство в
    // токене и не поставить файл — ровно тот дефект, при котором на машине
    // разработчика всё красиво (шрифт установлен в системе), а у человека нет.
    const css = readFileSync(resolve(STYLES_DIR, 'fonts.css'), 'utf8');
    const families = new Set(
      [...css.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]!),
    );
    expect([...families].sort()).toEqual(['Golos Text', 'JetBrains Mono', 'Source Serif 4']);
  });
});

describe('токены собраны из design/tokens.json', () => {
  it('сгенерированный CSS не разошёлся с источником', () => {
    // Тот же вызов, что в преflight и CI. Если кто-то правил
    // tokens.generated.css руками, здесь это и всплывёт.
    execFileSync('node', ['packages/ui/scripts/build-tokens.mjs', '--check'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
    });
  });

  it('в производном слое нет цветов, кроме направляющих чёрного и белого', () => {
    // color-mix(… , #000000) — это «на шаг темнее», а не цвет продукта.
    // Любой другой литерал в tokens.css означает значение мимо tokens.json.
    const css = readFileSync(resolve(STYLES_DIR, 'tokens.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const literals = [...css.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0].toUpperCase());
    const unexpected = literals.filter((hex) => !['#000000', '#FFFFFF', '#9C432F'].includes(hex));
    expect(unexpected, 'Цвет мимо design/tokens.json').toEqual([]);
  });
});

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
    // Карточки живут в @zapiski/app: стили экранов там, а не в библиотеке.
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
 * пикселя дал ровно `--accent-hover` вместо `--accent`. Причина не в цвете, а в том, что браузер
 * применяет `:hover` к последнему тронутому элементу и не снимает его.
 *
 * Понять это по коду было нельзя — только по пикселю с устройства. Поэтому
 * правило теперь стережётся тестом: каждое `:hover` в наших стилях живёт под
 * `@media (hover: hover)`.
 */
describe('наведение не прилипает на тач', () => {
  /** Стили компонентов библиотеки. */
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

/**
 * Слои: содержимое оверлея обязано лежать ВЫШЕ затемнения.
 *
 * Дефект, ради которого написан этот блок. У `--z-drawer` стояло 40, а у
 * `--z-scrim` — 50. Выдвижная библиотека оказывалась под собственным
 * затемнением, и оно перехватывало каждое нажатие: Архив, Корзина, Настройки
 * и Справка на телефоне не открывались вообще. Панель при этом прекрасно
 * видна — затемнение полупрозрачное, — поэтому со стороны это выглядело как
 * «жму, и ничего не происходит».
 *
 * Почему не поймали раньше. На ширине от 900 px библиотека рисуется
 * постоянной колонкой, без Drawer и без скрима, — на планшете и на десктопе
 * всё работало. А в happy-dom нет ни слоёв, ни попадания указателя, поэтому
 * модульные тесты компонентов молчали: Drawer исправно появлялся в дереве.
 */
describe('слои: затемнение не перекрывает то, что само подсвечивает', () => {
  const layerValue = (name: string): number => {
    const css = readFileSync(resolve(STYLES_DIR, 'tokens.generated.css'), 'utf8');
    const found = new RegExp(`--${name}:\\s*(\\d+)`).exec(css);
    expect(found, `в токенах нет --${name}`).not.toBeNull();
    return Number((found as RegExpExecArray)[1]);
  };

  /** Класс → токен слоя, как записано в Overlay.css. */
  const layerOf = (selector: string): string => {
    const css = readFileSync(
      resolve(STYLES_DIR, '../components/Overlay/Overlay.css'),
      'utf8',
    );
    const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    expect(block, `в Overlay.css нет правила ${selector}`).not.toBeNull();
    const layer = /z-index:\s*var\(--([a-z-]+)\)/.exec((block as RegExpExecArray)[1] as string);
    expect(layer, `у ${selector} нет z-index из токена`).not.toBeNull();
    return (layer as RegExpExecArray)[1] as string;
  };

  const scrim = layerValue(layerOf('.z-scrim'));

  /* Всё, что Drawer/Sheet/Modal показывают ВМЕСТЕ со скримом. Список ручной:
     важно не «какие есть классы», а «какие рисуются поверх затемнения». */
  for (const selector of ['.z-drawer', '.z-sheet', '.z-modal-layer']) {
    it(`${selector} лежит выше затемнения`, () => {
      const value = layerValue(layerOf(selector));
      expect(
        value,
        `${selector} на слое ${value}, затемнение на ${scrim} — нажатия не дойдут`,
      ).toBeGreaterThan(scrim);
    });
  }

  it('модалка остаётся выше выдвижной библиотеки', () => {
    // Иначе диалог, открытый из библиотеки, окажется под ней.
    expect(layerValue(layerOf('.z-modal-layer'))).toBeGreaterThan(layerValue(layerOf('.z-drawer')));
  });
});
