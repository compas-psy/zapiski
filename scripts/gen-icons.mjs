#!/usr/bin/env node
/**
 * Иконки всех форматов — из ОДНОГО векторного источника.
 *
 * Р5 мастер-ТЗ: «Акцент „Гранат“ везде, включая иконку. Иконка: существующий
 * знак-дерево на гранатовом фоне (новый знак не рисуем)».
 * `1_Design.md` §1.7 требует три формата: Android adaptive (foreground и
 * background раздельно), Windows `.ico` 16–256, favicon/PWA 192/512.
 *
 * ── Зачем скрипт, а не «нарисовать в редакторе» ─────────────────────────────
 *
 * В репозитории лежало пятнадцать растровых файлов, собранных с ПЛЕЙСХОЛДЕРА —
 * сплошного гранатового квадрата без дерева (`apps/web/public/icon.svg`,
 * 413 байт на 192×192). Знак при этом существовал рядом, в
 * `packages/ui/src/assets/services/zapiski.svg`. Расхождение продержалось
 * ровно потому, что растр собирают руками и один раз: источник поправили,
 * пятнадцать файлов — нет.
 *
 * Теперь источник один, и он тот же, что показывает `ServiceMark` в
 * интерфейсе. Пересборка — одна команда.
 *
 * ── Чем растеризуем ─────────────────────────────────────────────────────────
 *
 * Chromium, который уже есть для сторожей размеров и токенов. Он же отдаёт
 * сырые пиксели через canvas — это важно для `.ico`: формат хранит BGRA-строки
 * снизу вверх, и без сырых пикселей пришлось бы тащить в репозиторий декодер
 * PNG ради одного файла.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build   # не требуется, но браузер нужен
 *   node scripts/gen-icons.mjs
 *   node scripts/gen-icons.mjs --check      # CI: растр не разошёлся с SVG
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserEnv } from './find-chrome.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(REPO_ROOT, 'packages/ui/src/assets/services/zapiski.svg');
const CHROME = process.env.ZAPISKI_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHECK = process.argv.includes('--check');

/** Гранат из design/tokens.json: цвет плитки не выдумывается здесь. */
const TOKENS = JSON.parse(readFileSync(resolve(REPO_ROOT, 'design/tokens.json'), 'utf8'));
const PLATE = TOKENS.color.brand['svc-zapiski-bg'].$value;

function skip(reason) {
  console.log(`иконки: ПРОПУЩЕНО — ${reason}`);
  process.exit(0);
}

if (!existsSync(CHROME)) skip(`нет браузера по пути ${CHROME}`);
let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  skip('нет playwright-core');
}

const markup = readFileSync(SOURCE, 'utf8').trim();

/**
 * Три варианта одного знака.
 *
 *  · `mark` — как есть: плитка со скруглением 140/500 и дерево 0.74 стороны.
 *    Идёт в PWA, `.ico` и превью.
 *  · `maskable` — плитка БЕЗ скругления во весь холст: маску рисует система,
 *    и своё скругление под её маской превращается в срезанные углы. Дерево
 *    ужато до безопасной зоны маски.
 *  · `foreground` — только дерево, фон прозрачный: Android adaptive держит
 *    слои раздельно и сам двигает передний план при анимации.
 */
const PLATE_RECT = /<rect[^>]*\/?>(?:<\/rect>)?/;

function variant(kind) {
  if (kind === 'mark') return markup;
  if (kind === 'template') {
    /*
     * Строка меню macOS. Требование системы: ЧЁРНЫЙ силуэт с прозрачностью и
     * имя файла на `Template` — цвет система подбирает сама, по светлой и
     * тёмной теме и по подсветке при нажатии. Цветную иконку туда ставить
     * нельзя: в тёмной теме она превращается в мутное пятно.
     *
     * Плитки нет, знак крупнее: на плитке он занимает 0.74 стороны с полями,
     * а здесь поля рисует сама строка меню, и знак должен заполнять высоту.
     */
    return markup
      .replace(PLATE_RECT, '')
      .replace('scale(0.74)', 'scale(1.3)')
      .replace(/fill="#FBF3E3"/g, 'fill="#000000"');
  }
  if (kind === 'maskable') {
    /* Плитка во весь холст без скругления: маску рисует система. Размер
       дерева НЕ трогаем — 0.74 стороны это 0.43 видимой ширины, а безопасная
       зона маскируемой иконки — центральные 80%. Влезает с запасом. */
    return markup.replace(PLATE_RECT, `<rect width="500" height="500" fill="${PLATE}"></rect>`);
  }
  /* Передний план adaptive. Холст 108dp, видимыми после маски остаются
     центральные 72dp — две трети. Чтобы дерево выглядело ровно так же, как
     на плитке (там оно занимает 0.74 стороны), на этом холсте оно должно
     занимать 0.74 × 2/3 ≈ 0.49: иначе после маски знак окажется крупнее
     соседних иконок на том же экране. */
  return markup.replace(PLATE_RECT, '').replace('scale(0.74)', 'scale(0.49)');
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'], env: browserEnv() });
const page = await browser.newPage({ viewport: { width: 600, height: 600 } });

/** PNG нужного размера. Прозрачность сохраняется (`omitBackground`). */
async function png(kind, size) {
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">
       <div id="icon" style="width:${size}px;height:${size}px">${variant(kind)}</div>
     </body></html>`,
  );
  await page.evaluate((s) => {
    const svg = document.querySelector('#icon svg');
    svg.setAttribute('width', String(s));
    svg.setAttribute('height', String(s));
  }, size);
  const element = await page.$('#icon');
  return element.screenshot({ omitBackground: true, type: 'png' });
}

/** Сырые RGBA — для `.ico`, который хранит пиксели, а не PNG. */
async function rgba(kind, size) {
  const data = await page.evaluate(
    async ({ svg, s }) => {
      const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
      const image = new Image();
      await new Promise((done, fail) => {
        image.onload = done;
        image.onerror = fail;
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = s;
      canvas.height = s;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, s, s);
      return [...context.getImageData(0, 0, s, s).data];
    },
    { svg: variant(kind), s: size },
  );
  return Uint8Array.from(data);
}

/**
 * ICNS для macOS — контейнер из PNG.
 *
 * Формат простой: заголовок `icns` с общей длиной, дальше блоки
 * «четырёхбуквенный тип + длина + данные». Начиная с 10.7 в блоки кладут
 * PNG как есть, поэтому декодер здесь не нужен — ровно те же картинки, что
 * идут в остальные форматы.
 *
 * Набор типов не произвольный: система выбирает блок по запрошенному размеру
 * и плотности, и пропуск, например, `ic11` (16 pt @2x) даёт мыло в Dock на
 * Retina. Проще положить все восемь, чем потом искать, какого не хватило.
 */
function icns(blocks) {
  const chunks = [];
  let payload = 0;
  for (const [type, png] of blocks) {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, Buffer.from(png));
    payload += png.length + 8;
  }
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(payload + 8, 4);
  return Buffer.concat([head, ...chunks]);
}

/**
 * ICO из сырых пикселей, формат BMP (не PNG-in-ICO).
 *
 * PNG внутри ICO понимают Vista и новее, но ресурсный компоновщик Windows и
 * часть читателей `.ico` ждут именно DIB. Разница в размере файла нам не
 * важна, а формат, который понимают все, — важен: иконка исполняемого файла
 * не то место, где стоит экономить.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // тип: иконка
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  const bodies = [];
  let offset = 6 + images.length * 16;

  for (const { size, pixels } of images) {
    const rowBytes = size * 4;
    const maskRow = Math.ceil(size / 32) * 4; // AND-маска: 1 бит на пиксель, кратно 4
    const dib = Buffer.alloc(40 + rowBytes * size + maskRow * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8); // высота = картинка + маска
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14); // бит на пиксель
    dib.writeUInt32LE(0, 16); // BI_RGB
    dib.writeUInt32LE(rowBytes * size, 20);

    /* BMP хранит строки снизу вверх и порядок каналов BGRA. */
    for (let y = 0; y < size; y += 1) {
      const source = (size - 1 - y) * rowBytes;
      const target = 40 + y * rowBytes;
      for (let x = 0; x < size; x += 1) {
        dib[target + x * 4] = pixels[source + x * 4 + 2];
        dib[target + x * 4 + 1] = pixels[source + x * 4 + 1];
        dib[target + x * 4 + 2] = pixels[source + x * 4];
        dib[target + x * 4 + 3] = pixels[source + x * 4 + 3];
      }
    }
    /* Маска нулевая: прозрачность несёт альфа-канал. */

    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 означает 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(dib.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += dib.length;

    entries.push(entry);
    bodies.push(dib);
  }
  return Buffer.concat([header, ...entries, ...bodies]);
}

/* ── Что и куда кладём ───────────────────────────────────────────────────────
   Плотности Android: mdpi 48 → xxxhdpi 192 для готовой иконки и 108dp-холст
   переднего плана в тех же плотностях (108 / 162 / 216 / 324 / 432). */
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];

const plan = [
  ['apps/web/public/icon-192.png', 'mark', 192],
  ['apps/web/public/icon-512.png', 'mark', 512],
  ['apps/web/public/icon-maskable-512.png', 'maskable', 512],
  ['apps/desktop/src-tauri/icons/32x32.png', 'mark', 32],
  ['apps/desktop/src-tauri/icons/128x128.png', 'mark', 128],
  ['apps/desktop/src-tauri/icons/128x128@2x.png', 'mark', 256],
  ['apps/desktop/src-tauri/icons/icon.png', 'mark', 512],
  /* Строка меню macOS: 22 pt и та же иконка для Retina. Имя обязано
     заканчиваться на `Template` — по нему система понимает, что цвет её. */
  ['apps/desktop/src-tauri/icons/menubar-Template.png', 'template', 22],
  ['apps/desktop/src-tauri/icons/menubar-Template@2x.png', 'template', 44],
  ['apps/mobile/src-tauri/icons/32x32.png', 'mark', 32],
  ['apps/mobile/src-tauri/icons/128x128.png', 'mark', 128],
  ['apps/mobile/src-tauri/icons/128x128@2x.png', 'mark', 256],
  ['apps/mobile/src-tauri/icons/icon.png', 'mark', 512],
];
for (const [density, launcher, foreground] of DENSITIES) {
  plan.push([`apps/mobile/android/app/src/main/res/mipmap-${density}/ic_launcher.png`, 'mark', launcher]);
  plan.push([
    `apps/mobile/android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`,
    'foreground',
    foreground,
  ]);
}

const written = [];
const stale = [];

async function put(relativePath, data) {
  const full = resolve(REPO_ROOT, relativePath);
  const same = existsSync(full) && Buffer.compare(readFileSync(full), Buffer.from(data)) === 0;
  if (same) return;
  if (CHECK) {
    stale.push(relativePath);
    return;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  written.push(relativePath);
}

for (const [target, kind, size] of plan) {
  await put(target, await png(kind, size));
}

/* Windows: один файл со всеми размерами, которые запрашивает проводник. */
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of icoSizes) images.push({ size, pixels: await rgba('mark', size) });
await put('apps/desktop/src-tauri/icons/icon.ico', ico(images));

/* macOS: один файл со всеми размерами, которые спрашивает система. */
const icnsBlocks = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];
const icnsData = [];
for (const [type, size] of icnsBlocks) icnsData.push([type, await png('mark', size)]);
await put('apps/desktop/src-tauri/icons/icon.icns', icns(icnsData));

/* Веб: тот же знак вектором — favicon и `manifest.webmanifest`. */
await put('apps/web/public/icon.svg', Buffer.from(`${markup}\n`, 'utf8'));

/* Android adaptive: слои раздельно, фон — плоский цвет, а не картинка. */
await put(
  'apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml',
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!-- СГЕНЕРИРОВАНО scripts/gen-icons.mjs из design/tokens.json. -->\n` +
      `<resources>\n    <color name="ic_launcher_background">${PLATE}</color>\n</resources>\n`,
    'utf8',
  ),
);
for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  await put(
    `apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/${name}`,
    Buffer.from(
      `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<!-- СГЕНЕРИРОВАНО scripts/gen-icons.mjs. Слои раздельно: маску формы\n` +
        `     рисует система, поэтому своего скругления у переднего плана нет. -->\n` +
        `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n` +
        `    <background android:drawable="@color/ic_launcher_background" />\n` +
        `    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n` +
        `</adaptive-icon>\n`,
      'utf8',
    ),
  );
}

await browser.close();

if (CHECK) {
  if (stale.length > 0) {
    console.error('иконки: растр разошёлся с источником:');
    for (const file of stale) console.error(`  · ${file}`);
    console.error('Пересоберите: node scripts/gen-icons.mjs');
    process.exit(1);
  }
  console.log(`иконки: совпадают с ${relative(REPO_ROOT, SOURCE)}`);
  process.exit(0);
}

console.log(`иконки: собрано из ${relative(REPO_ROOT, SOURCE)}, файлов обновлено ${written.length}`);
for (const file of written) console.log(`  · ${file}`);
