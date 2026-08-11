#!/usr/bin/env node
/**
 * Копирует self-hosted .woff2 из пакетов @fontsource в packages/ui/src/fonts/
 * и генерирует packages/ui/src/styles/fonts.css с локальными путями.
 *
 * Запуск: pnpm --filter @zapiski/ui fonts:sync
 *
 * Зачем скрипт, а не прямой импорт '@fontsource/...' :
 *   DESIGN_TOKENS.md §2 требует, чтобы шрифты поставлялись в сборке и в рантайме
 *   не было обращений к CDN. Файлы лежат в репозитории, @fontsource нужен только
 *   на этапе обновления (devDependency).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const modules = resolve(pkgRoot, 'node_modules/@fontsource');
const fontsOut = resolve(pkgRoot, 'src/fonts');
const cssOut = resolve(pkgRoot, 'src/styles/fonts.css');

/** Что вендорим. Подмножества: только латиница и кириллица (проект ru/en).
 *
 * tz/ZAPISKI_TZ_1_Design.md §1, строка «Шрифты» — принято и не пересматривается:
 * Golos Text (интерфейс и текст заметки), Source Serif 4 («бумажный» режим),
 * JetBrains Mono (код, даты, raw). Geist, пришедший с чужой дизайн-системой,
 * из набора убран вместе с ней.
 *
 * Golos Text — гуманистический гротеск с кириллицей как первым письмом, а не
 * как довеском: у Geist кириллица есть только в публикации из Google Fonts, и
 * это была отдельная ловушка. JetBrains Mono держит кириллицу в моноширинном —
 * важно для raw-режима, где текст заметки набран моноширинным целиком.
 */
const PLAN = [
  { pkg: 'golos-text', family: 'Golos Text', weights: [400, 500, 600, 700], styles: ['normal'] },
  { pkg: 'source-serif-4', family: 'Source Serif 4', weights: [400, 600], styles: ['normal', 'italic'] },
  { pkg: 'jetbrains-mono', family: 'JetBrains Mono', weights: [400, 500], styles: ['normal'] },
];
const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'];

const faceRe = /@font-face\s*\{([^}]*)\}/g;
const declRe = /([a-z-]+)\s*:\s*([^;]+);/g;

function parseFaces(css) {
  const faces = [];
  for (const m of css.matchAll(faceRe)) {
    const decls = {};
    for (const d of m[1].matchAll(declRe)) decls[d[1].trim()] = d[2].trim();
    const src = decls['src'] ?? '';
    const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(src)?.[1];
    if (!file) continue;
    faces.push({
      family: (decls['font-family'] ?? '').replace(/['"]/g, ''),
      style: decls['font-style'] ?? 'normal',
      weight: decls['font-weight'] ?? '400',
      unicodeRange: decls['unicode-range'] ?? null,
      file,
    });
  }
  return faces;
}

mkdirSync(fontsOut, { recursive: true });

const out = [];
const copied = [];
out.push('/* СГЕНЕРИРОВАНО packages/ui/scripts/sync-fonts.mjs — не редактировать вручную. */');
out.push('/* Шрифты self-hosted: ни одного обращения к CDN в рантайме (DESIGN_TOKENS.md §2). */');
out.push('');

for (const item of PLAN) {
  const base = resolve(modules, item.pkg);
  if (!existsSync(base)) {
    console.error(`[fonts] нет пакета @fontsource/${item.pkg} — пропуск`);
    continue;
  }
  out.push(`/* ── ${item.family} ─────────────────────────────────────────── */`);
  for (const style of item.styles) {
    for (const weight of item.weights) {
      const cssName = style === 'italic' ? `${weight}-italic.css` : `${weight}.css`;
      const cssPath = resolve(base, cssName);
      if (!existsSync(cssPath)) continue;
      const faces = parseFaces(readFileSync(cssPath, 'utf8')).filter((f) =>
        SUBSETS.some((s) => f.file.includes(`-${s}-`)),
      );
      // Порядок: latin последним, чтобы кириллица имела приоритет при равных диапазонах.
      for (const face of faces) {
        copyFileSync(resolve(base, 'files', face.file), resolve(fontsOut, face.file));
        copied.push(face.file);
        out.push('@font-face {');
        out.push(`  font-family: '${face.family}';`);
        out.push(`  font-style: ${face.style};`);
        out.push(`  font-weight: ${face.weight};`);
        out.push('  font-display: swap;');
        out.push(`  src: url('../fonts/${face.file}') format('woff2');`);
        if (face.unicodeRange) out.push(`  unicode-range: ${face.unicodeRange};`);
        out.push('}');
      }
    }
  }
  const license = resolve(base, 'LICENSE');
  if (existsSync(license)) copyFileSync(license, resolve(fontsOut, `LICENSE-${item.pkg}.txt`));
  out.push('');
}

writeFileSync(cssOut, out.join('\n'));
console.log(`[fonts] скопировано ${copied.length} .woff2 → src/fonts/`);
console.log(`[fonts] сгенерирован ${cssOut}`);
