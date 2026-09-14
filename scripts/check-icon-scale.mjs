#!/usr/bin/env node
/**
 * Крупность знака в готовых иконках — приёмка ICON-SPEC §6.
 *
 * ── Что проверяется ─────────────────────────────────────────────────────────
 *
 *   высота дерева ÷ высота ВИДИМОЙ плитки = 0,60 ± 0,02
 *
 * Знак-дерево один на девять сервисов СИМПАСа, поэтому разъехаться в нём
 * может ровно одно — крупность. Рядом на домашнем экране разница читается
 * как иконки разных компаний, и ICON-SPEC заводился именно из-за этого.
 *
 * ── Почему измерением, а не чтением числа из скрипта ────────────────────────
 *
 * `gen-icons.mjs` выводит масштабы из правила, и сверять его с самим собой
 * бессмысленно: ошибка в выводе сойдётся сама с собой. Здесь открываются
 * ГОТОВЫЕ файлы и меряется то же, что померил бы человек линейкой в
 * инспекторе, — по пикселям, а не по разметке.
 *
 * Так же ловится и вторая ошибка того же класса: считать крупность от холста
 * 108 dp вместо видимых 72 dp. Она даёт знак на треть мельче задуманного, и
 * в разметке выглядит совершенно законно — видна только в измерении.
 *
 * ── Чем меряем ──────────────────────────────────────────────────────────────
 *
 * Chromium, который уже есть у остальных сторожей: он отдаёт сырые пиксели
 * через canvas, и тащить в репозиторий декодер PNG ради одной проверки не
 * приходится.
 *
 * Запуск:
 *   node scripts/check-icon-scale.mjs [--strict]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserEnv, findChrome } from './find-chrome.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRICT = process.argv.includes('--strict');
const CHROME = findChrome();

const skip = (reason) => {
  console.log(`Крупность иконок: пропуск — ${reason}`);
  process.exit(STRICT ? 1 : 0);
};

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core');
}
if (CHROME === null) skip('браузер не найден — поставьте Chromium или задайте ZAPISKI_CHROME');

/** Правило системы. Единственное число, от которого всё считается. */
const RULE = 0.6;
const TOLERANCE = 0.02;

/**
 * Что меряем.
 *
 * `visible` — какую долю холста видно после маски платформы. Именно от неё
 * считается крупность, и именно её проще всего перепутать с размером холста.
 */
const TARGETS = [
  {
    file: 'apps/web/public/icon-512.png',
    what: 'плоская плитка (PWA, сторы, favicon)',
    visible: 1,
  },
  {
    file: 'apps/desktop/msix/assets/Square310x310Logo.png',
    what: 'плитка Microsoft Store',
    visible: 1,
  },
  {
    file: 'apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png',
    what: 'Android adaptive — передний план',
    visible: 72 / 108,
  },
  {
    file: 'apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_monochrome.png',
    what: 'Android adaptive — тематический силуэт',
    visible: 72 / 108,
  },
  {
    file: 'apps/web/public/icon-maskable-512.png',
    what: 'PWA maskable (видно центральные 80 %)',
    visible: 0.8,
  },
];

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], env: browserEnv() });
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });

const problems = [];

/**
 * Габарит знака в пикселях.
 *
 * Знак ищется как «всё, что не фон»: у слоёв Android фон прозрачный, у плитки
 * — сплошная заливка цвета сервиса. Отдельного списка цветов не заводим, он
 * устарел бы вместе со сменой палитры: фон берётся пробой с самого холста.
 *
 * Проба — СЕРЕДИНА ВЕРХНЕЙ КРОМКИ, а не левый верхний угол. Угол у плитки со
 * скруглением 0,28 стороны прозрачен, и по нему «всё, что не фон» означало
 * всю плитку целиком: первая версия этой проверки насчитала крупность 1,000
 * там, где на самом деле было 0,459. Середина кромки лежит внутри заливки у
 * плитки и остаётся прозрачной у слоёв Android — то есть верна в обоих
 * случаях, а знак до неё не достаёт при любой законной крупности.
 */
async function treeBox(pngPath) {
  const base64 = readFileSync(pngPath).toString('base64');
  return page.evaluate(async (data) => {
    const image = new Image();
    await new Promise((done, fail) => {
      image.onload = done;
      image.onerror = fail;
      image.src = `data:image/png;base64,${data}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const { data: px, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);

    const at = (x, y) => {
      const i = (y * width + x) * 4;
      return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    };
    const bg = at(Math.floor(width / 2), 2);
    /*
     * Знак — это НЕПРОЗРАЧНЫЕ пиксели, отличающиеся от фона по цвету.
     *
     * Непрозрачность в условии обязательна. Без неё прозрачные углы плитки со
     * скруглением 0,28 считались «не фоном» наравне со знаком, и габарит
     * выходил во весь холст: вторая версия этой проверки насчитала крупность
     * 1,000 там, где было 0,459. Углы лежат в самых крайних строках, поэтому
     * ошибка била ровно по измеряемой величине — высоте.
     *
     * Порог по сумме модулей, а не точное равенство: сглаженные края знака
     * отличаются от фона заметно сильнее, чем шум компрессии, а точное
     * сравнение отрезало бы антиалиасинг вместе с половиной кроны.
     */
    const opaque = (c) => c[3] > 128;
    const isTree =
      bg[3] < 128
        ? opaque
        : (c) =>
            opaque(c) &&
            Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 90;

    let top = null;
    let bottom = null;
    let left = null;
    let right = null;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!isTree(at(x, y))) continue;
        if (top === null) top = y;
        bottom = y;
        if (left === null || x < left) left = x;
        if (right === null || x > right) right = x;
      }
    }
    return top === null ? null : { top, bottom, left, right, width, height };
  }, base64);
}

for (const target of TARGETS) {
  const full = resolve(REPO_ROOT, target.file);
  if (!existsSync(full)) {
    problems.push(`${target.file}: файла нет — иконки не собраны`);
    continue;
  }
  const box = await treeBox(full);
  if (box === null) {
    problems.push(`${target.what}: на холсте не нашлось знака вовсе (${target.file})`);
    continue;
  }

  const treeHeight = box.bottom - box.top + 1;
  const visibleHeight = box.height * target.visible;
  const ratio = treeHeight / visibleHeight;
  const verdict = Math.abs(ratio - RULE) <= TOLERANCE;

  console.log(
    `  ${verdict ? '✓' : '✗'} ${target.what}: дерево ${treeHeight} px из видимых ` +
      `${Math.round(visibleHeight)} px — ${ratio.toFixed(3)}`,
  );
  if (!verdict) {
    problems.push(
      `${target.what}: крупность ${ratio.toFixed(3)} вместо ${RULE} ± ${TOLERANCE} — ` +
        `${ratio > RULE ? 'знак крупнее' : 'знак мельче'} соседних иконок СИМПАСа (${target.file})`,
    );
  }

  /* Центрирование: центр bbox знака обязан совпасть с центром холста. Знак
     нарисован так, что центр bbox уже в центре viewBox, поэтому расхождение
     здесь означает сдвиг, внесённый сборкой, — а сдвинутый знак срежется
     маской раньше соседей. Допуск в один пиксель — на нечётные размеры. */
  const offsetY = (box.top + box.bottom) / 2 - box.height / 2;
  const offsetX = (box.left + box.right) / 2 - box.width / 2;
  if (Math.abs(offsetY) > 1.5 || Math.abs(offsetX) > 1.5) {
    problems.push(
      `${target.what}: знак сдвинут от центра на ${offsetX.toFixed(1)} × ${offsetY.toFixed(1)} px`,
    );
  }
}

/* Android: дерево обязано лежать внутри безопасного круга 66 dp — только
   тогда оно переживает любую маску OEM (круг, squircle, teardrop). */
const fg = resolve(
  REPO_ROOT,
  'apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png',
);
if (existsSync(fg)) {
  const box = await treeBox(fg);
  if (box !== null) {
    const dp = box.width / 108;
    const halfW = (box.right - box.left + 1) / 2;
    const halfH = (box.bottom - box.top + 1) / 2;
    const corner = Math.hypot(halfW, halfH) / dp;
    const safe = 66 / 2;
    if (corner > safe) {
      problems.push(
        `Android: угол габарита знака в ${corner.toFixed(1)} dp от центра — за пределами ` +
          `безопасного круга ${safe} dp, маска OEM его срежет`,
      );
    } else {
      console.log(`  ✓ Android: знак внутри безопасного круга (${corner.toFixed(1)} dp из ${safe})`);
    }
  }
}

/* Цвет плашки Android берётся из того же токена, что и плитка. Расхождение
   здесь — это фон одного цвета и знак другого на одном экране. */
const plateXml = resolve(
  REPO_ROOT,
  'apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml',
);
const tokens = JSON.parse(readFileSync(resolve(REPO_ROOT, 'design/tokens.json'), 'utf8'));
const plate = tokens.color.brand['svc-zapiski-bg'].$value;
if (existsSync(plateXml)) {
  const declared = /name="ic_launcher_background">([^<]+)</.exec(readFileSync(plateXml, 'utf8'))?.[1];
  if (declared?.toUpperCase() !== plate.toUpperCase()) {
    problems.push(`Android: плашка ${declared} не совпадает с токеном ${plate}`);
  } else {
    console.log(`  ✓ Android: плашка ${declared} — из design/tokens.json`);
  }
}

await browser.close();

if (problems.length > 0) {
  console.error('Крупность иконок: расхождения');
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error('Пересоберите: node scripts/gen-icons.mjs');
  process.exit(1);
}
console.log('Крупность иконок: пройден — знак 0,60 видимой плитки везде');
