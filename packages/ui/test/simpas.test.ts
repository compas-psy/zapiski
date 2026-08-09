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
