/**
 * Токены (DESIGN_TOKENS §4, ARCHITECTURE §3.4).
 *
 * «Ни одного hex вне токен-файла» — в этом пакете токен-файлов нет вообще,
 * значит hex не должно быть нигде. Тест дублирует репозиторный линтер
 * намеренно: он ловит нарушение до коммита, а не в CI.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_CODE_TOKENS,
  REQUIRED_FONT_TOKENS,
  REQUIRED_SURFACE_TOKENS,
} from '../src/theme/tokens.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** `#` в markdown-примерах и в коде символов — не цвет. */
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/g;

describe('цвета только через var(--*)', () => {
  it('в исходниках пакета нет ни одного hex-значения', () => {
    const guilty: string[] = [];
    for (const file of sources(SRC)) {
      const matches = readFileSync(file, 'utf8').match(HEX);
      if (matches) guilty.push(`${relative(SRC, file)}: ${matches.join(', ')}`);
    }
    expect(guilty).toEqual([]);
  });

  it('каждый цвет в теме берётся из переменной', () => {
    const theme = readFileSync(join(SRC, 'theme', 'base-theme.ts'), 'utf8');
    const colorLines = theme
      .split('\n')
      .filter((line) => /(?:color|backgroundColor|borderLeft|stroke|fill)\s*:/i.test(line))
      .filter((line) => !line.includes('//'));
    for (const line of colorLines) {
      const usesVar = line.includes('var(--');
      const neutral = /'(transparent|inherit|none|currentColor)'/.test(line);
      expect(usesVar || neutral, `цвет не из токена: ${line.trim()}`).toBe(true);
    }
  });

  it('список требуемых токенов покрывает и палитру подсветки кода', () => {
    expect(REQUIRED_SURFACE_TOKENS).toContain('--accent-soft');
    expect(REQUIRED_CODE_TOKENS).toEqual([
      '--code-keyword',
      '--code-string',
      '--code-number',
      '--code-comment',
      '--code-function',
    ]);
    expect(REQUIRED_FONT_TOKENS.length).toBe(3);
  });
});
