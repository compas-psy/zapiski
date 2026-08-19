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
 *
 * Самопроверка — где угодно, Windows не нужна:
 *   node apps/desktop/msix/build-msix.mjs --self-test
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
export function versionProblem(version) {
  const parts = String(version).split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
    return `версия пакета должна быть вида Major.Minor.Build.Revision, получено «${version}»`;
  }
  if (parts[3] !== '0') return `последняя секция версии обязана быть нулём, получено «${version}»`;
  if (parts[0] === '0') return `первая секция версии не может быть нулём, получено «${version}»`;
  if (parts.some((p) => Number(p) > 65535)) return `секции версии не больше 65535, получено «${version}»`;
  return null;
}

/** Заполнить шаблон манифеста значениями identity.json. */
export function fillManifest(template, values) {
  let manifest = template;
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('_')) continue;
    manifest = manifest.replaceAll(`{{${key}}}`, String(value));
  }
  const unresolved = manifest.match(/\{\{[^}]+\}\}/g);
  return { manifest, unresolved };
}

/**
 * Где лежит собранный exe.
 *
 * Каталог зависит от того, собирали с явным триплетом или без. Наш workflow
 * собирает под `x86_64-pc-windows-msvc`, и тогда release лежит НЕ в
 * `target/release`, а в `target/x86_64-pc-windows-msvc/release`. Первая версия
 * этого скрипта знала только второй путь — и на CI молча не находила бы exe,
 * оставляя в логе одно предупреждение вместо пакета.
 */
export function releaseCandidates(targetRoot, exists = existsSync) {
  const found = [];
  const push = (dir) => {
    if (!found.includes(dir)) found.push(dir);
  };
  if (process.env.ZAPISKI_MSIX_RELEASE_DIR) push(process.env.ZAPISKI_MSIX_RELEASE_DIR);
  push(join(targetRoot, 'x86_64-pc-windows-msvc', 'release'));
  push(join(targetRoot, 'release'));
  /* Перебор остальных триплетов — на случай сборки под иной target. Каталога
     может не быть вовсе (и в самопроверке его нет заведомо), поэтому чтение
     каталога не имеет права ронять поиск. */
  try {
    for (const entry of readdirSync(targetRoot)) {
      const candidate = join(targetRoot, entry, 'release');
      if (exists(candidate)) push(candidate);
    }
  } catch {
    /* нет каталога сборки — список кандидатов остаётся из известных путей */
  }
  return found;
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const version = String(identity.packageVersion || '');
const versionIssue = versionProblem(version);
if (versionIssue !== null) fail(versionIssue);

// ── 2. Что кладём в пакет ──────────────────────────────────────────────────
const targetRoot = join(desktop, 'src-tauri', 'target');
const searched = releaseCandidates(targetRoot);
const releaseDir = searched.find((dir) => existsSync(join(dir, identity.executable)));
if (releaseDir === undefined) {
  fail(
    `не найден ${identity.executable}. Искали в:\n  ${searched.join('\n  ')}\n` +
      'Сначала «tauri build», потом сборка MSIX.',
  );
}
const exeSource = join(releaseDir, identity.executable);
console.log(`MSIX: собранный exe — ${exeSource}`);

const staging = join(targetRoot, 'msix-staging');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(exeSource, join(staging, identity.executable));
cpSync(join(here, 'assets'), join(staging, 'assets'), { recursive: true });

// ── 3. Манифест ────────────────────────────────────────────────────────────
// UTF-8 без BOM: PublisherDisplayName написан кириллицей, и в любой другой
// кодировке имя издателя приедет искажённым, а пакет будет отклонён.
const template = readFileSync(join(here, 'AppxManifest.template.xml'), 'utf8');
const { manifest, unresolved } = fillManifest(template, identity);
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
// Рядом с остальными бандлами того же release-каталога, а не в вымышленном.
const outDir = join(releaseDir, 'bundle', 'msix');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `ZAPISKI_${version}_x64.msix`);
rmSync(outFile, { force: true });

console.log(`MSIX: makeappx = ${makeappx}`);
execFileSync(makeappx, ['pack', '/d', staging, '/p', outFile, '/o'], { stdio: 'inherit' });

const size = statSync(outFile).size;
console.log(`MSIX: собран ${outFile} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
console.log('MSIX: пакет НЕ подписан — так и должно быть, подпись ставит Microsoft Store при публикации.');
/* Машиночитаемая строка для workflow: путь зависит от каталога сборки, и
   угадывать его шаблоном в YAML — способ снова разъехаться. */
console.log(`MSIX_FILE=${outFile}`);


function selfTest() {
  const checks = [];
  const check = (name, condition) => checks.push({ name, ok: Boolean(condition) });

  check('версия 1.0.0.0 принимается', versionProblem('1.0.0.0') === null);
  check('версия 0.1.0 отвергается', versionProblem('0.1.0') !== null);
  check('версия 0.1.0.0 отвергается: первая секция ноль', versionProblem('0.1.0.0') !== null);
  check('версия 1.0.0.1 отвергается: последняя секция не ноль', versionProblem('1.0.0.1') !== null);
  check('секция больше 65535 отвергается', versionProblem('1.65536.0.0') !== null);
  check('версия пакета в identity.json валидна', versionProblem(identity.packageVersion) === null);

  const template = readFileSync(join(here, 'AppxManifest.template.xml'), 'utf8');
  const filled = fillManifest(template, identity);
  check('в манифесте не осталось подстановок', filled.unresolved === null);
  check('имя издателя приехало кириллицей', filled.manifest.includes(identity.publisherDisplayName));
  const missed = fillManifest(template, { ...identity, displayName: undefined, _skip: 1 });
  check('пропущенное значение замечается', String(missed.manifest).includes('undefined'));

  /* Ровно тот дефект, из-за которого пакет не собрался бы на CI: сборка идёт
     под триплет, а скрипт искал exe только в target/release. */
  const fake = new Set(['/t', '/t/x86_64-pc-windows-msvc/release']);
  const dirs = releaseCandidates('/t', (d) => fake.has(d));
  check(
    'каталог сборки под триплет входит в поиск',
    dirs.includes(join('/t', 'x86_64-pc-windows-msvc', 'release')),
  );
  check('каталог сборки без триплета тоже входит', dirs.includes(join('/t', 'release')));

  for (const { name, ok } of checks) console.log(`${ok ? '  ok  ' : ' ОТКАЗ '} ${name}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`MSIX: самопроверка не прошла (${failed.length} из ${checks.length}).`);
    process.exit(1);
  }
  console.log(`MSIX: самопроверка пройдена, ${checks.length} проверок.`);
}
