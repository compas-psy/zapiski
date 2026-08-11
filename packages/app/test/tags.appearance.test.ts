/**
 * Вид тегов (ITERATION-1 §7).
 *
 * Правило одной строкой: заливку `--accent-soft` получает ТОЛЬКО активный
 * фильтр. Тег в тексте заметки и в её шапке — цвет акцента на прозрачном, без
 * подложки, рамки и подчёркивания; решётка того же цвета, но приглушённая.
 *
 * Почему сторож. Подложка у тега возвращается не по решению, а по привычке:
 * «чип» в любой библиотеке компонентов заливной, и первый же новый экран
 * приносит её обратно. При этом ошибка не выглядит ошибкой — просто плотность
 * растёт, пока текст не начинает тонуть в цветных плашках (DS-ALIGNMENT §10:
 * плотность добирается воздухом, а не цветом).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** Тело правила по селектору. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `правило ${selector} не найдено`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('тег в шапке заметки', () => {
  const chip = read('packages/ui/src/components/Chip/Chip.css');

  it('без заливки', () => {
    expect(rule(chip, '.z-tag')).toContain('background-color: transparent');
  });

  it('цветом акцента', () => {
    expect(rule(chip, '.z-tag')).toContain('color: var(--accent)');
  });

  it('без рамки', () => {
    expect(rule(chip, '.z-tag')).toContain('border: 0');
  });
});

describe('тег в тексте заметки', () => {
  const theme = read('packages/editor/src/theme/base-theme.ts');

  it('прозрачный фон и цвет акцента', () => {
    const tag = theme.slice(theme.indexOf("'.cm-z-tag':"), theme.indexOf("'.cm-z-footnote'"));
    expect(tag).toContain("color: 'var(--accent)'");
    expect(tag).toContain("backgroundColor: 'transparent'");
  });

  it('без подчёркивания — §7 запрещает прямо', () => {
    const tag = theme.slice(theme.indexOf("'.cm-z-tag':"), theme.indexOf("'.cm-z-footnote'"));
    expect(tag).toContain("textDecoration: 'none'");
  });

  it('решётка приглушена, а не другого цвета', () => {
    expect(theme).toContain("'.cm-z-tag-hash': { opacity: '0.6' }");
  });
});

describe('заливка живёт ровно в одном месте', () => {
  it('accent-soft у чипов — только у активного фильтра', () => {
    const chip = read('packages/ui/src/components/Chip/Chip.css');
    /* Все селекторы этого файла, в теле которых стоит заливка акцентом. */
    const filled = [...chip.matchAll(/\n(\.[a-z0-9-]+(?:[^{}\n]*)?) \{([^}]*)\}/gi)]
      .filter(([, , body]) => (body ?? '').includes('background-color: var(--accent-soft)'))
      .map(([, selector]) => (selector ?? '').trim());

    /* Активный фильтр — и бейдж-акцент, который тегом не является. */
    expect(filled.sort()).toEqual(['.z-badge--accent', '.z-filter--active']);
  });

  it('в строке списка тегов нет вовсе', () => {
    /* §7: «В строке списка теги не показываются вовсе». Проверяется по
       разметке строки, а не по стилям: спрятать цветом — не то же самое. */
    const row = read('packages/app/src/components/NoteRow.tsx');
    expect(row).not.toContain('note.tags');
    expect(row).not.toContain('<Tag');
  });
});

describe('дерево тегов', () => {
  it('счётчик ноль не печатается', () => {
    /* REBUILD §1.12 и §7: ноль притягивает внимание к пустоте. */
    const panel = read('packages/app/src/screens/LibraryPanel.tsx');
    expect(panel).toContain('draft.count > 0');
  });
});
