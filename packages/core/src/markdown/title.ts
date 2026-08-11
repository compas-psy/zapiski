/**
 * Заголовок заметки как отдельное поле (ITERATION-1 §1).
 *
 * Раньше заголовком считалась просто первая непустая строка, чем бы она ни
 * была. В списке из-за этого оказывался случайный обрывок: заметка, начатая с
 * `###`, так и называлась — «###». Человек при этом не понимал, где кончается
 * название и начинается текст, потому что отдельного поля не было вовсе.
 *
 * Теперь правило узкое и обратимое:
 *
 *   · заголовок — ТОЛЬКО первая строка вида `# Название`;
 *   · тело — всё, что после неё, и этого H1 оно не содержит;
 *   · если файл начинается не с H1 — заголовок пуст, а текст остаётся телом
 *     целиком. Ни строчки не переносим и не переписываем: это чужой vault, и
 *     он вправе быть устроен иначе (§1, «file over app»).
 *
 * Пустой заголовок — разрешённое состояние, а не ошибка. В списке такая
 * заметка называется «Без названия», а не первой строкой тела.
 */
import { joinFrontmatter, splitFrontmatter, type Frontmatter } from './frontmatter.js';

/** H1 и только H1: `## Раздел` — часть тела, а не название заметки. */
const H1 = /^#[ \t]+(.*)$/;

export interface NoteTitleSplit {
  /** Текст заголовка без `# `. Пустая строка — законное значение. */
  title: string;
  /** Тело вместе с frontmatter, если он был. Строки заголовка в нём нет. */
  body: string;
}

/**
 * Разбирает файл на заголовок и тело.
 *
 * Frontmatter остаётся в теле: он служебный, но принадлежит файлу, и терять
 * его при разборе нельзя. Заголовок ищется сразу после него — файл с
 * frontmatter'ом и `# Название` следом разбирается так же, как без него.
 */
export function splitTitle(text: string): NoteTitleSplit {
  const { frontmatter, body } = splitFrontmatter(text);
  const lines = body.split('\n');

  let first = 0;
  while (first < lines.length && (lines[first] as string).trim() === '') first += 1;
  if (first === lines.length) return { title: '', body: text };

  const heading = H1.exec((lines[first] as string).trim());
  if (!heading) return { title: '', body: text };

  const rest = lines.slice(first + 1);
  while (rest.length > 0 && (rest[0] as string).trim() === '') rest.shift();
  return { title: (heading[1] as string).trim(), body: attach(frontmatter, rest.join('\n')) };
}

/**
 * Собирает файл обратно. Обратна `splitTitle` на канонических файлах:
 * `splitTitle` → `joinTitle` возвращает исходный текст.
 *
 * Пустой заголовок H1 не пишет вовсе — иначе файл, у которого названия нет,
 * получил бы пустую строку `# ` и перестал открываться чужим редактором так,
 * как открывался.
 */
export function joinTitle(title: string, body: string): string {
  const { frontmatter, body: text } = splitFrontmatter(body);
  const clean = title.trim();
  if (clean === '') return attach(frontmatter, text);
  return attach(frontmatter, text === '' ? `# ${clean}\n` : `# ${clean}\n\n${text.replace(/^\n+/, '')}`);
}

function attach(frontmatter: Frontmatter | null, body: string): string {
  return frontmatter ? joinFrontmatter(frontmatter, body) : body;
}
