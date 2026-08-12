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

/**
 * Каждый токен, на который ссылается пакет, обязан существовать.
 *
 * Дефект, ради которого написан этот блок: панель форматирования просила
 * `--shadow-card` и `--shadow-pop`, которых не было НИ В ОДНОМ файле токенов.
 * Оба стояли с фолбэками — `var(--shadow-card, var(--elev-search))` — и потому
 * не ломались, а молча подставляли чужие тени: пилюле досталась тень поисковой
 * строки, выпадающему меню — тень полноэкранной модалки `0 24px 60px`.
 * Заказчик увидел это как «неправильные тени», и никакой тест возразить не мог.
 *
 * Мораль шире теней: фолбэк в `var()` превращает опечатку и пропущенный токен
 * в тихое «работает не так». Поэтому сторожатся оба условия — токен есть, и
 * фолбэка при нём нет.
 */
describe('токены, которые просит пакет, существуют', () => {
  const UI_STYLES = join(SRC, '..', '..', 'ui', 'src', 'styles');
  const declared = new Set<string>();
  for (const file of ['tokens.generated.css', 'tokens.css']) {
    const css = readFileSync(join(UI_STYLES, file), 'utf8');
    for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) declared.add(match[1] as string);
  }

  /**
   * Переменные, которые пакет объявляет САМ, а не берёт из дизайн-системы:
   * `--z-*` и `--cm-*` — тема редактора, `--editor-*` — множители настроек,
   * `--zp-*` — панель форматирования (её же префикс, что у классов `.zp-panel`);
   * последние ставятся из JS по измеренному месту на экране.
   *
   * Список именно префиксов, а не имён: иначе каждая новая переменная темы
   * ломала бы сторож, и его начали бы обходить, а не поправлять.
   */
  const OWN = /^--(z|cm|editor|zp)-/;

  it('каталог токенов вообще прочитался', () => {
    /* Сторож без предмета бесполезен: при сломанном разборе проверки ниже
       прошли бы «успешно», ничего не проверив. */
    expect(declared.size).toBeGreaterThan(50);
  });

  it('ни одной ссылки на несуществующий токен', () => {
    const missing: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const name = match[1] as string;
        if (OWN.test(name) || declared.has(name)) continue;
        missing.push(`${relative(SRC, file)}: ${name}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('у теней панели нет фолбэков, прячущих подмену', () => {
    const panel = readFileSync(join(SRC, 'react', 'FormatPanel.tsx'), 'utf8');
    for (const token of ['--shadow-card', '--shadow-pop']) {
      expect(panel).toContain(`var(${token})`);
      expect(panel, `${token} снова с фолбэком`).not.toMatch(
        new RegExp(`var\\(${token},`),
      );
    }
  });
});
