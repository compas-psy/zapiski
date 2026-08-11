/**
 * Сторож палитры экспорта.
 *
 * Экспортный HTML/PDF не может ссылаться на рантайм-токены темы, поэтому цвета
 * в нём литеральные. Ровно из-за этого они однажды и разъехались с
 * дизайн-системой: подсветка `==текст==` в экспорте была золотистой `#F3E7B8`,
 * хотя DESIGN_TOKENS §2 требует `--accent-soft`.
 *
 * Этот тест делает расхождение невозможным: он перезапускает генератор и
 * сравнивает результат с тем, что лежит в репозитории. Правка токенов без
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
  it('синхронна с packages/ui/src/styles/tokens.generated.css', () => {
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

  it('берёт значения светлой темы «Бумага», а не тёмной', () => {
    // Регрессия: безусловный блок акцента легко перекрыть тёмным вариантом,
    // и тогда в печать уедет полупрозрачная rgba, непригодная для бумаги.
    expect(PRINT_PALETTE.bg).toBe('#FBFAF7');
    expect(PRINT_PALETTE.text).toBe('#38342E');
    expect(PRINT_PALETTE.accentSoft).toBe('#F6E7E2');
  });

  it('подсветка ==текст== в экспорте равна --accent-soft акцента по умолчанию', () => {
    // Источник один — design/tokens.json, и тест читает именно его, а не CSS:
    // так проверяется вся цепочка «источник → генератор → палитра печати».
    const tokens = JSON.parse(
      readFileSync(resolve(ROOT, 'design/tokens.json'), 'utf8'),
    ) as { color: { accent: { garnet: { light: { 'accent-soft': { $value: string } } } } } };

    const soft = tokens.color.accent.garnet.light['accent-soft'].$value;
    expect(soft.toUpperCase()).toBe(PRINT_PALETTE.accentSoft);
  });
});
