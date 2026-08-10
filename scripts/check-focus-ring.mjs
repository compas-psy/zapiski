/**
 * Одно кольцо фокуса на поле (REBUILD §1.5).
 *
 * У поля в модалке было видно два кольца разного радиуса: своё на оболочке
 * и ещё одно на самом `input` — от общего правила `.z-focusable:focus-visible`
 * в `base.css`. Читая код, это не увидеть: правила лежат в разных пакетах и
 * складываются только на экране. Поэтому проверка меряет ВЫЧИСЛЕННЫЕ стили в
 * живом браузере.
 *
 * Запуск:
 *   pnpm --filter "@zapiski/web..." build
 *   node scripts/check-focus-ring.mjs
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const CHROME =
  process.env.ZAPISKI_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
if (!existsSync(CHROME)) {
  console.log(`фокус: ПРОПУЩЕНО — нет браузера по пути ${CHROME}`);
  process.exit(0);
}
const PORT = process.env.ZAPISKI_PORT ?? '4202'; const URL_BASE = `http://127.0.0.1:${PORT}/`;
const alive = async () => { try { await fetch(URL_BASE, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; } };
let server = null;
if (!(await alive())) { server = spawn('npx', ['--yes','serve','-s','apps/web/dist','-l',PORT], {stdio:'ignore'});
  for (let i=0;i<40 && !(await alive());i+=1) await new Promise(r=>setTimeout(r,500)); }
const browser = await chromium.launch({ executablePath: CHROME, args:['--no-sandbox'] });
const page = await browser.newPage({ viewport:{width:1280,height:820}, locale:'ru-RU' });
await page.goto(URL_BASE, { waitUntil:'networkidle' });
const click = async (re) => { const b = page.getByRole('button',{name:re}).first();
  if ((await b.count())>0) await b.click({force:true}).catch(()=>undefined); await page.waitForTimeout(450); };
await click(/Начать/); await click(/Дальше/); await page.waitForTimeout(800);
await click(/Новая папка/); await page.waitForTimeout(500);
const rings = await page.evaluate(() => {
  const input = document.querySelector('.z-field__input') ?? document.querySelector('input');
  const out = [];
  /* Только сам input и его обёртки поля: тень модалки — это тень карточки,
     а не кольцо фокуса, и считать её было бы ложной тревогой. */
  let el = input;
  while (el && (el === input || el.className?.toString?.().startsWith('z-field'))) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.push({
      tag: el.tagName.toLowerCase(), cls: el.className?.toString?.() ?? '',
      rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}`,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      radius: s.borderRadius, outline: `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor}`,
      shadow: s.boxShadow, bg: s.backgroundColor,
    });
    el = el.parentElement;
  }
  return out;
});
const drawn = rings.filter(
  (e) => e.shadow !== 'none' || (e.outline !== '' && !e.outline.startsWith('0px')),
);
for (const e of drawn) console.log(`кольцо на ${e.tag}.${e.cls}: shadow ${e.shadow}`);
await browser.close();
server?.kill();

if (drawn.length === 1) {
  console.log('фокус: одно кольцо — как требует REBUILD §1.5');
  process.exit(0);
}
console.error(`фокус: колец ${drawn.length}, должно быть одно`);
process.exit(1);
