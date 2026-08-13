#!/usr/bin/env node
/**
 * Сторож: своя строка заголовка не должна соседствовать с системной.
 *
 * ── Дефект, ради которого написан этот файл ─────────────────────────────────
 *
 * В окне Windows оказалось ДВА ряда кнопок «свернуть/развернуть/закрыть»:
 * системный и наш. При этом в `tauri.conf.json` честно стоит
 * `"decorations": false`, а `TitleBar` рисуется ровно один раз — все ветки
 * раскладки в `App.tsx` взаимоисключающие.
 *
 * Виноват `tauri-plugin-window-state`. `Builder::default()` сохраняет и
 * восстанавливает `StateFlags::all()`, а среди них есть `DECORATIONS`: плагин
 * пишет состояние рамки в `.window-state.json` и при следующем запуске
 * применяет его ПОВЕРХ конфига. У тех, кто запускал версию до перехода на
 * свою строку заголовка, там лежит `decorations: true` — и системная рамка
 * возвращается навсегда.
 *
 * Почему это переживает сборки: на чистой установке файла состояния нет, и
 * всё выглядит правильно. Дефект есть только у обновившихся — то есть у
 * заказчика и ни у кого из проверяющих.
 *
 * Правило, которое здесь сторожится: если оболочка объявила окно без
 * системных декораций, плагин состояния не имеет права их восстанавливать.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Оболочки с собственным окном. У Android окна нет — его ведёт система. */
const SHELLS = [
  {
    name: 'desktop',
    conf: 'apps/desktop/src-tauri/tauri.conf.json',
    rust: 'apps/desktop/src-tauri/src/lib.rs',
  },
];

const problems = [];

for (const shell of SHELLS) {
  const conf = JSON.parse(readFileSync(resolve(ROOT, shell.conf), 'utf8'));
  const windows = conf.app?.windows ?? [];
  const frameless = windows.filter((window) => window.decorations === false);
  if (frameless.length === 0) continue;

  const rustPath = resolve(ROOT, shell.rust);
  if (!existsSync(rustPath)) {
    problems.push(`${shell.name}: нет ${shell.rust} — проверить нечего`);
    continue;
  }
  const rust = readFileSync(rustPath, 'utf8');

  /* Плагин может быть и не подключён — тогда восстанавливать нечего. */
  if (!/tauri_plugin_window_state::Builder/.test(rust)) continue;

  /* Комментарии убираем: слово DECORATIONS встречается в объяснении выше, и
     без этого сторож принял бы рассказ о дефекте за его починку. */
  const code = rust.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const excluded =
    /with_state_flags/.test(code) && /StateFlags::DECORATIONS/.test(code);

  if (!excluded) {
    problems.push(
      `${shell.name}: окно объявлено без системных декораций ` +
        `(decorations: false в ${shell.conf}), но tauri-plugin-window-state ` +
        'восстанавливает StateFlags::all() — вместе с DECORATIONS. У всех, кто ' +
        'обновился с версии с системной рамкой, она вернётся, и кнопок окна ' +
        'станет два ряда. Исключите флаг через .with_state_flags(...)',
    );
  }
}

if (problems.length > 0) {
  console.error('Хром окна: своя строка заголовка получит системную в соседи:');
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exit(1);
}

console.log('Хром окна: системная рамка не вернётся поверх своей строки заголовка');
