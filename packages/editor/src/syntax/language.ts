/**
 * Языковой слой: GFM + фирменные расширения + подсветка кода в блоках.
 *
 * DESIGN_TOKENS §1 требует пастельной подсветки, переключающейся вместе с
 * темой; список языков — «около двадцати» из ТЗ. Языки грузятся динамически
 * (`LanguageDescription.load`), поэтому в бандл попадает только то, что реально
 * встретилось в тексте.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages as allLanguageDescriptions } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { zapiskiMarkdownExtensions } from './markdown-ext.js';

/**
 * Двадцать четыре языка, которые реально встречаются в заметках.
 * Порядок не важен — сопоставление идёт по имени и алиасам инфо-строки
 * («```python», «```py», «```ts»).
 */
const CURATED = [
  'JavaScript',
  'TypeScript',
  'JSX',
  'TSX',
  'HTML',
  'CSS',
  'JSON',
  'Python',
  'Rust',
  'Go',
  'Java',
  'Kotlin',
  'Swift',
  'C',
  'C++',
  'C#',
  'PHP',
  'Ruby',
  'Shell',
  'SQL',
  'YAML',
  'TOML',
  'XML',
  'diff',
];

/** Курируемый набор языков подсветки (~20, ТЗ). */
export const codeLanguages: LanguageDescription[] = CURATED.map((name) =>
  allLanguageDescriptions.find((l) => l.name === name),
).filter((l): l is LanguageDescription => Boolean(l));

/** Полный набор из `@codemirror/language-data` — на случай, если нужно всё. */
export const allCodeLanguages: LanguageDescription[] = allLanguageDescriptions;

export interface MarkdownLanguageOptions {
  /** Чем подсвечивать код в ```-блоках. По умолчанию — курируемый набор. */
  codeLanguages?: LanguageDescription[];
}

/**
 * Markdown-язык КОМПАС.ЗАПИСКИ: GFM (таблицы, чекбоксы, зачёркивание,
 * автоссылки) плюс `==подсветка==`, `[[wiki]]`, `#тег`, `[^сноска]`.
 */
export function zapiskiMarkdown(options: MarkdownLanguageOptions = {}): Extension {
  return markdown({
    // markdownLanguage = CommonMark + GFM (у commonmarkLanguage таблиц нет).
    base: markdownLanguage,
    codeLanguages: options.codeLanguages ?? codeLanguages,
    extensions: zapiskiMarkdownExtensions,
    addKeymap: false, // свой keymap собираем сами, BEHAVIOR §7
  });
}
