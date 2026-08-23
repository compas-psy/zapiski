/**
 * Каждый вызов `NativeBridge.<что-то>` обязан существовать.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────────
 *
 * При вырезании самоустановки я снёс из `NativeBridge` заодно `result(...)` —
 * функцию, через которую В КАЖДОЙ асинхронной операции Kotlin возвращает ответ
 * в Rust. Двадцать три вызова в трёх файлах остались без объявления. Сборка
 * упала, но узнать об этом можно было только через `tauri android build`:
 * четыре минуты Gradle на раннере с Android SDK.
 *
 * Существующий шаг «Импорты Kotlin» такого не ловит — он про импорты, а не про
 * вызовы. Эта проверка стоит миллисекунды и не требует ни SDK, ни JVM: она
 * сверяет имена, которые зовут, с именами, которые объявлены.
 *
 * Не замена компилятору: типы и аргументы здесь не проверяются. Но самый
 * дорогой вид опечатки — «функции больше нет» — ловится до раннера.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const KOTLIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../android/app/src/main/java/ru/cmpas/zapiski',
);

const sources = readdirSync(KOTLIN)
  .filter((name) => name.endsWith('.kt'))
  .map((name) => ({ name, text: readFileSync(path.join(KOTLIN, name), 'utf8') }));

const bridge = sources.find((file) => file.name === 'NativeBridge.kt');

/** Имена, объявленные в объекте `NativeBridge`. */
function declared(): Set<string> {
  const names = new Set<string>();
  for (const match of (bridge?.text ?? '').matchAll(/\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  // Свойства тоже зовут через точку.
  for (const match of (bridge?.text ?? '').matchAll(/\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return names;
}

describe('поверхность NativeBridge', () => {
  it('файл на месте и в нём что-то объявлено', () => {
    expect(bridge).toBeDefined();
    expect(declared().size).toBeGreaterThan(5);
  });

  it('каждое имя, которое зовут через NativeBridge., объявлено в нём', () => {
    const names = declared();
    const missing: string[] = [];

    for (const file of sources) {
      if (file.name === 'NativeBridge.kt') continue;
      for (const match of file.text.matchAll(/\bNativeBridge\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const called = match[1];
        if (called !== undefined && !names.has(called)) missing.push(`${file.name}: ${called}`);
      }
    }

    expect(
      [...new Set(missing)],
      missing.length === 0
        ? ''
        : `В NativeBridge зовут то, чего в нём нет:\n  ${[...new Set(missing)].join('\n  ')}`,
    ).toEqual([]);
  });
});
