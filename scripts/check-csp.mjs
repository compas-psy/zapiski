#!/usr/bin/env node
/**
 * Сторож: политика безопасности, которую WebView получит на устройстве,
 * не должна убивать стили редактора.
 *
 * ── Дефект, ради которого написан этот файл ─────────────────────────────────
 *
 * В `apps/mobile/index.html` стоял один инлайновый <style> — «фон первого
 * кадра», шесть строк. Tauri дописывает `nonce` каждому <style> в HTML
 * (`tauri-utils`: `inject_nonce(document, "style", STYLE_NONCE_TOKEN)`) и
 * добавляет `'nonce-…'` в `style-src` политики, которую отдаёт WebView.
 * А по спецификации CSP nonce в директиве ОТМЕНЯЕТ `'unsafe-inline'`.
 *
 * Из JS стили вставляют и CodeMirror, и панель форматирования: это
 * StyleModule, устройство редактора, а не наше решение. Значит на устройстве
 * не применялось НИЧЕГО из оформления редактора: кнопки панели рисовались
 * серыми системными квадратами, таблица показывалась сырым markdown, вокруг
 * текста светилось кольцо фокуса от WebView. В вебе того же <style> нет —
 * там всё выглядело правильно, и отзывы годами читались как «на Android
 * почему-то не так».
 *
 * Замерено на одной и той же сборке, разница только в заголовке CSP:
 *
 *              | `style-src 'self' 'unsafe-inline'` | то же + nonce
 *   .zp-panel  | display: flex                      | display: block
 *   кнопка     | 36 px, радиус 10                   | 28 px, радиус 0, ButtonFace
 *   .cm-content| padding: 36px 32px                 | padding: 0
 *
 * ── Почему сторож статический ───────────────────────────────────────────────
 *
 * Проверить это браузером нельзя: дефект живёт ровно в связке «HTML + Tauri»,
 * а мобильная сборка без Tauri-IPC до редактора не доходит. Поэтому здесь
 * воспроизводится ПРАВИЛО, по которому Tauri модифицирует политику, и
 * проверяется его исход. Правило одно и то же для всех оболочек.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Оболочки, которым политику отдаёт Tauri. У веба CSP своя, от сервера.
 *
 * `dist` проверяется отдельно и только если он собран: Tauri читает СОБРАННЫЙ
 * html, и вставить туда <style> может сам сборщик — тогда в исходнике будет
 * чисто, а на устройстве мертво.
 */
const SHELLS = [
  {
    name: 'mobile',
    html: 'apps/mobile/index.html',
    dist: 'apps/mobile/dist/index.html',
    conf: 'apps/mobile/src-tauri/tauri.conf.json',
  },
  {
    name: 'desktop',
    html: 'apps/desktop/index.html',
    dist: 'apps/desktop/dist/index.html',
    conf: 'apps/desktop/src-tauri/tauri.conf.json',
  },
];

const problems = [];
const note = (shell, message) => problems.push(`${shell}: ${message}`);

/** Сколько в разметке настоящих <style>. */
function countStyles(html) {
  /* Комментарии <!-- ... --> вырезаются: слово «style» встречается в них
     часто, и без этого сторож ловил бы собственное объяснение. */
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  return (markup.match(/<style[\s>]/gi) ?? []).length;
}

for (const shell of SHELLS) {
  const conf = JSON.parse(readFileSync(resolve(ROOT, shell.conf), 'utf8'));
  const security = conf.app?.security ?? {};
  const csp = String(security.csp ?? '');

  const sources = [{ path: shell.html, what: 'исходной разметке' }];
  const dist = resolve(ROOT, shell.dist);
  if (existsSync(dist)) sources.push({ path: shell.dist, what: 'СОБРАННОЙ разметке' });

  const inline = sources
    .map((source) => ({ ...source, count: countStyles(readFileSync(resolve(ROOT, source.path), 'utf8')) }))
    .filter((source) => source.count > 0);

  const disabled = security.dangerousDisableAssetCspModification;
  const styleProtected =
    disabled === true || (Array.isArray(disabled) && disabled.includes('style-src'));

  /* Полагаемся ли мы вообще на инлайновые стили. Если однажды `style-src`
     перестанет их разрешать, StyleModule умрёт и без всякого nonce — и это
     сторож обязан заметить, иначе он охраняет не то. */
  if (!/style-src[^;]*'unsafe-inline'/.test(csp)) {
    note(
      shell.name,
      "в `style-src` нет 'unsafe-inline' — CodeMirror и панель форматирования " +
        'вставляют свои стили из JS (StyleModule) и работать не будут',
    );
  }

  if (!styleProtected) {
    for (const source of inline) {
      note(
        shell.name,
        `в ${source.what} (${source.path}) ${source.count} инлайновых <style> — ` +
          "Tauri допишет им nonce, nonce отменит 'unsafe-inline', и на устройстве " +
          'умрут все стили редактора. Либо вынесите стили в отдельный .css, либо ' +
          'добавьте "dangerousDisableAssetCspModification": ["style-src"]',
      );
    }
  }
}

if (problems.length > 0) {
  console.error('Политика безопасности убьёт стили редактора:');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log(`CSP оболочек: стили редактора переживут её (проверено оболочек: ${SHELLS.length})`);
