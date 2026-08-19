#!/usr/bin/env node
/**
 * Сборка MSIX для Microsoft Store.
 *
 * Зачем это существует: Tauri не умеет собирать MSIX (его бандлер знает nsis и
 * msi), а Store не переподписывает MSI/EXE — только MSIX. Магазин нам нужен
 * ровно затем, чтобы получить подпись Microsoft бесплатно: сертификат
 * Authenticode российскому разработчику сейчас не продаёт ни один CA.
 *
 * Пакет НЕ подписывается здесь. Store подписывает его сам своим сертификатом,
 * и загрузка неподписанного пакета в Partner Center — штатный путь. Локально
 * такой файл не установится (это ожидаемо), проверка — только через магазин.
 *
 * Запуск (только на Windows, после `tauri build`):
 *   node apps/desktop/msix/build-msix.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const identity = JSON.parse(readFileSync(join(here, 'identity.json'), 'utf8'));

function fail(message) {
  console.error(`MSIX: ${message}`);
  process.exit(1);
}

// ── 1. Версия ──────────────────────────────────────────────────────────────
// Требование Microsoft: четыре секции, последняя обязана быть нулём (она
// зарезервирована за магазином), первая нулём быть не может. Версия приложения
// 0.1.0 под это не подходит в принципе — отсюда отдельное поле packageVersion.
// Проверка стоит здесь, а не в голове: отклонённая загрузка стоит суток.
const version = String(identity.packageVersion || '');
const parts = version.split('.');
if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
  fail(`версия пакета должна быть вида Major.Minor.Build.Revision, получено «${version}»`);
}
if (parts[3] !== '0') fail(`последняя секция версии обязана быть нулём, получено «${version}»`);
if (parts[0] === '0') fail(`первая секция версии не может быть нулём, получено «${version}»`);
if (parts.some((p) => Number(p) > 65535)) fail(`секции версии не больше 65535, получено «${version}»`);

// ── 2. Что кладём в пакет ──────────────────────────────────────────────────
const exeSource = join(desktop, 'src-tauri', 'target', 'release', identity.executable);
if (!existsSync(exeSource)) {
  fail(`не найден ${exeSource}. Сначала «tauri build», потом сборка MSIX.`);
}

const staging = join(desktop, 'src-tauri', 'target', 'msix-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(exeSource, join(staging, identity.executable));
cpSync(join(here, 'assets'), join(staging, 'assets'), { recursive: true });

// ── 3. Манифест ────────────────────────────────────────────────────────────
// UTF-8 без BOM: PublisherDisplayName написан кириллицей, и в любой другой
// кодировке имя издателя приедет искажённым, а пакет будет отклонён.
let manifest = readFileSync(join(here, 'AppxManifest.template.xml'), 'utf8');
for (const [key, value] of Object.entries(identity)) {
  if (key.startsWith('_')) continue;
  manifest = manifest.replaceAll(`{{${key}}}`, String(value));
}
const unresolved = manifest.match(/\{\{[^}]+\}\}/g);
if (unresolved) fail(`в манифесте остались незаполненные подстановки: ${unresolved.join(', ')}`);
writeFileSync(join(staging, 'AppxManifest.xml'), manifest, 'utf8');

// ── 4. makeappx из Windows SDK ─────────────────────────────────────────────
function findMakeAppx() {
  if (process.env.MAKEAPPX_PATH) return process.env.MAKEAPPX_PATH;
  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ].filter((r) => existsSync(r));
  const found = [];
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, 'x64', 'makeappx.exe');
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  if (!found.length) fail('makeappx.exe не найден. Нужен Windows SDK; на раннере windows-latest он есть.');
  // Самая свежая версия SDK: имена каталогов сортируются как версии.
  found.sort();
  return found[found.length - 1];
}

const makeappx = findMakeAppx();
const outDir = join(desktop, 'src-tauri', 'target', 'release', 'bundle', 'msix');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `ZAPISKI_${version}_x64.msix`);
rmSync(outFile, { force: true });

console.log(`MSIX: makeappx = ${makeappx}`);
execFileSync(makeappx, ['pack', '/d', staging, '/p', outFile, '/o'], { stdio: 'inherit' });

const size = statSync(outFile).size;
console.log(`MSIX: собран ${outFile} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
console.log('MSIX: пакет НЕ подписан — так и должно быть, подпись ставит Microsoft Store при публикации.');
