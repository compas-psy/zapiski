/**
 * Сторож палитры экспорта.
 *
 * Экспортный HTML/PDF не может ссылаться на рантайм-токены темы, поэтому цвета
 * в нём литеральные. Ровно из-за этого они однажды и разъехались с
 * дизайн-системой: подсветка `==текст==` в экспорте была золотистой `#F3E7B8`,
 * хотя DESIGN_TOKENS §2 требует `--accent-soft`.
 *
 * Этот тест делает расхождение невозможным: он перезапускает генератор и
 * сравнивает результат с тем, что лежит в репозитории. Правка tokens.css без
 * пересборки палитры роняет CI.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRINT_PALETTE } from '../src/export/print-palette.js';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

describe('палитра экспорта', () => {
  it('синхронна с packages/ui/src/styles/tokens.css', () => {
    // Генератор в режиме --check сам сравнивает файл с источником и падает
    // с ненулевым кодом при расхождении.
    expect(() =>
      execFileSync('node', ['scripts/gen-print-palette.mjs', '--check'], {
        cwd: ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('содержит только литеральные #rrggbb — печать не умеет color-mix', () => {
    for (const [key, value] of Object.entries(PRINT_PALETTE)) {
      expect(value, `${key} должен быть литеральным цветом`).toMatch(
        /^#[0-9A-F]{6}$/,
      );
    }
  });

  it('берёт значения светлой темы СИМПАС, а не тёмной', () => {
    // Регрессия: безусловный блок акцента легко перекрыть тёмным вариантом,
    // и тогда в печать уедет полупрозрачная rgba, непригодная для бумаги.
    expect(PRINT_PALETTE.bg).toBe('#F7F8F4');
    expect(PRINT_PALETTE.text).toBe('#142018');
    expect(PRINT_PALETTE.accentSoft).toBe('#E7F0EA');
  });

  it('подсветка ==текст== в экспорте равна --accent-soft акцента по умолчанию', () => {
    // После перехода на дизайн-систему значение живёт в ДВУХ файлах: наш
    // tokens.css объявляет алиас (`--accent-soft: var(--sage-…)`), а литерал
    // лежит в снимке системы. Поэтому тест разворачивает ссылку, а не ищет
    // hex там, где его больше нет.
    const strip = (path: string) =>
      readFileSync(resolve(ROOT, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    const tokens = strip('packages/ui/src/styles/tokens.css');
    const system = strip('packages/ui/src/styles/simpas/vendor/tokens/colors.css');

    // Светлая «Хвоя» — безусловный блок [data-accent='pine'].
    const pine = tokens.slice(tokens.indexOf("[data-accent='pine']"));
    const declared = /--accent-soft:\s*([^;]+);/.exec(pine)?.[1]?.trim();
    expect(declared, 'в tokens.css не найден --accent-soft для «Хвои»').toBeTruthy();

    const link = /^var\((--[\w-]+)\)$/.exec(declared!);
    const literal = link
      ? new RegExp(`${link[1]}:\\s*(#[0-9A-Fa-f]{6})`).exec(system)?.[1]
      : declared;

    expect(literal?.toUpperCase()).toBe(PRINT_PALETTE.accentSoft);
  });
});
