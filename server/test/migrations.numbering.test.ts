/**
 * Номер миграции должен быть уникален — иначе он перестаёт что-либо значить.
 *
 * ── Почему это завелось ──────────────────────────────────────────────────────
 *
 * Третий случай подряд: две ветки независимо заняли один номер.
 *   * `feature/tbank-acquiring-and-price` и соседняя — `0007`;
 *   * `feature/analytics-device-id` принесла `0007_analytics_device.sql` при
 *     уже существующем `0007_tbank.sql`.
 * Трижды — это не случайность, а отсутствие правила.
 *
 * ── Чем это опасно на самом деле ─────────────────────────────────────────────
 *
 * Раннер (`server/src/db/migrate.ts`) не падает: `version` — это полное имя
 * файла без `.sql`, поэтому `0007_tbank` и `0007_analytics_device` для него
 * две РАЗНЫЕ миграции, и применятся обе. Ломается другое: файлы
 * применяются `.sort()`, то есть по алфавиту, и при равных номерах порядок
 * решает ХВОСТ имени. `0007_analytics_device` уедет перед `0007_tbank`
 * просто потому, что «a» < «t». Номер, который для того и нужен, чтобы
 * задавать порядок, перестаёт его задавать.
 *
 * Хуже, что это тихо: на сервере, где один `0007` уже применён, второй
 * спокойно накатится следом, и расхождение порядка между двумя окружениями
 * никто не заметит до первой миграции, которой этот порядок важен.
 *
 * ── Правило ──────────────────────────────────────────────────────────────────
 *
 * Следующий свободный номер берётся в ВЕТКЕ ПО УМОЛЧАНИЮ, а не в своей:
 * своя ветка не знает про чужие. Этот тест — механическая проверка правила;
 * он падает и в ветке, и на слиянии, то есть до сервера.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

interface Migration {
  file: string;
  number: number;
}

function migrations(dir = MIGRATIONS): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const prefix = /^(\d{4})_/.exec(file);
      if (prefix === null) {
        throw new Error(
          `Миграция ${file} названа не по правилу: имя обязано начинаться с четырёх цифр и подчёркивания (0013_что_делает.sql).`,
        );
      }
      return { file, number: Number(prefix[1]) };
    })
    .sort((a, b) => a.number - b.number);
}

describe('нумерация миграций', () => {
  it('файлы вообще нашлись — иначе тест зелен впустую', () => {
    expect(migrations().length).toBeGreaterThanOrEqual(12);
  });

  it('каждое имя начинается с четырёхзначного номера', () => {
    expect(() => migrations()).not.toThrow();
  });

  it('два файла не занимают один номер', () => {
    const byNumber = new Map<number, string[]>();
    for (const { file, number } of migrations()) {
      byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
    }

    const collisions = [...byNumber.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([number, files]) => `${String(number).padStart(4, '0')}: ${files.join(' и ')}`);

    // Сообщение говорит, что делать: переименовать более позднюю в следующий
    // свободный номер. Молчаливое «expected [] to equal []» тут бесполезно —
    // человек упирается в него ровно в момент слияния двух веток.
    expect(
      collisions,
      collisions.length === 0
        ? ''
        : `Один номер занят дважды:\n  ${collisions.join('\n  ')}\n` +
            'Переименуйте ту, что появилась позже, в следующий свободный номер ' +
            'ветки по умолчанию. Если миграция уже применена на сервере — ' +
            'переименовывать нельзя (раннер узнаёт её по имени), нужна новая.',
    ).toEqual([]);
  });

  it('номера идут подряд от 0001 — дыра означает потерянную или переименованную миграцию', () => {
    const numbers = migrations().map((m) => m.number);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });
});
