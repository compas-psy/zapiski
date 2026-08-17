/**
 * Промостраница обещает сборки — а выкладывают их workflow'ы. Здесь
 * проверяется, что обещание и выкладка говорят об одном файле.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * `/promo` ссылается на постоянные адреса `/updates/latest/zapiski.apk` и
 * `/updates/latest/zapiski-setup.exe`. Кладут туда файлы шаги «Отдать APK на
 * сервер» и «Отдать установщик на сервер» — то есть имя живёт в двух местах
 * сразу, в HTML и в YAML, и ничто их не связывает.
 *
 * Переименуйте файл в workflow — и страница станет отдавать 404. Причём
 * узнается это не из красного прогона, а из письма человека, которому дали
 * ссылку: «скачать не получается». Ровно тот класс дефекта, где всё зелёное, а
 * продукт недоступен.
 *
 * Проверка чисто текстовая, сети не требует и потому годится в любой прогон:
 * она сверяет ДВА ИСТОЧНИКА между собой, а не сайт.
 *
 * Отдельно проверяется, что на странице есть обе сборки: страница без ссылки
 * на Windows формально исправна и практически бесполезна.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROMO = path.join(ROOT, 'apps/web/public/promo/index.html');
const WORKFLOWS = [
  path.join(ROOT, '.github/workflows/build-android.yml'),
  path.join(ROOT, '.github/workflows/build-windows.yml'),
];

/** Что промостраница обязана предлагать. Меньше — не страница выпуска. */
const REQUIRED = [
  { what: 'Android', pattern: /\.apk$/ },
  { what: 'Windows', pattern: /\.exe$/ },
];

const problems = [];

const promo = await readFile(PROMO, 'utf8');

/** Ссылки на постоянный каталог свежих сборок, как их видит браузер. */
const promoLinks = [
  ...new Set(
    [...promo.matchAll(/href="\/updates\/latest\/([^"]+)"/g)].map((match) => match[1]),
  ),
];

/**
 * Имена, которые workflow'ы кладут в `updates/latest`.
 *
 * Ищем присваивание пути с этим каталогом: `'${latest}/zapiski.apk'`,
 * `"${latest}/zapiski-setup.exe"`. Кавычки и способ подстановки у двух
 * workflow'ов разные, поэтому шаблон описывает форму, а не строку.
 */
const published = new Set();
for (const file of WORKFLOWS) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\$\{latest\}\/([A-Za-z0-9._-]+)/g)) {
    published.add(match[1]);
  }
  for (const match of text.matchAll(/\$2\/([A-Za-z0-9._-]+)/g)) {
    published.add(match[1]);
  }
  /* Windows пишет имя внутри heredoc через переменную `latest`, объявленную
     в самом скрипте: `cp -f "${exe}" "${latest}/zapiski-setup.exe"`. Ловится
     первым шаблоном. Дополнительно берём прямые упоминания каталога. */
  for (const match of text.matchAll(/updates\/latest\/([A-Za-z0-9._-]+)/g)) {
    published.add(match[1]);
  }
}

/* Сторож без предмета бесполезен: если разбор сломался, ниже всё «совпадёт». */
if (promoLinks.length === 0) {
  problems.push(
    `в ${path.relative(ROOT, PROMO)} не нашлось ни одной ссылки на /updates/latest/ — ` +
      'либо страница перестала предлагать сборки, либо сломался разбор',
  );
}
if (published.size === 0) {
  problems.push('в workflow\'ах не нашлось ни одного файла, который кладут в updates/latest');
}

// ── Каждая ссылка страницы обязана кем-то выкладываться ─────────────────────
for (const link of promoLinks) {
  if (!published.has(link)) {
    problems.push(
      `промостраница ссылается на /updates/latest/${link}, но ни один workflow ` +
        'такого файла не кладёт — ссылка отдаст 404',
    );
  }
}

// ── И обе сборки на странице есть ───────────────────────────────────────────
for (const { what, pattern } of REQUIRED) {
  if (!promoLinks.some((link) => pattern.test(link))) {
    problems.push(`на промостранице нет ссылки на сборку ${what}`);
  }
}

if (problems.length > 0) {
  console.error('Ссылки промостраницы: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(
  `Ссылки промостраницы: ${promoLinks.length} шт., каждая выкладывается workflow'ом ` +
    `(${promoLinks.join(', ')})`,
);
