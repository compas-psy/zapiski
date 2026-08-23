/**
 * Имя APK не ездит через outputs job — GitHub их молча выбрасывает.
 *
 * ── Что случилось ───────────────────────────────────────────────────────────
 *
 * Прогон 188 «Сборка Android». В хвосте лога, в разделе «Evaluate and set job
 * outputs»:
 *
 *     Skip output 'apk' since it may contain secret.
 *     Skip output 'artifact' since it may contain secret.
 *
 * Причина видна там же, строкой выше: и в адресе из сообщения об ошибке
 * (`https://…cmpas.ru/updates/latest/….apk`), и в пути рабочего каталога
 * (`/home/runner/work/…`) на месте имени продукта стоят три звёздочки —
 * подпись вычеркнутого секрета. То есть ЗНАЧЕНИЕ одного из секретов
 * репозитория — само слово «zapiski». GitHub вычёркивает его из логов
 * подстрокой и по тому же правилу отказывается пропускать через outputs job
 * любое значение, где оно встретилось. Имя файла сборки содержит его всегда —
 * по правилу СИМПАС, и до правила содержало тоже.
 *
 * ── Чем это опасно ──────────────────────────────────────────────────────────
 *
 * Прогон 188 упал раньше, на выкладке, и до релизного job не дошёл — иначе
 * отказ был бы куда хуже сборочного. `needs.build.outputs.apk` пришёл бы
 * ПУСТОЙ СТРОКОЙ, а не ошибкой:
 *
 *   • `actions/download-artifact` с пустым `name` скачивает ВСЕ артефакты
 *     прогона, раскладывая их иначе, чем ждёт следующий шаг;
 *   • `scp "artifacts/"` без имени файла не сделает того, что обещает;
 *   • в манифест обновления уехал бы адрес `https://zapiski.cmpas.ru/updates/`
 *     — ссылка на каталог вместо пакета. Клиент пошёл бы по ней за
 *     обновлением.
 *
 * Ни одна из трёх бед не назвала бы причину: пустая строка выглядит как
 * значение, а предупреждение о пропуске остаётся в логе ЧУЖОГО job.
 *
 * ── Что стережётся ──────────────────────────────────────────────────────────
 *
 * Имена не передаются между job вовсе. Они вычисляются из версии тем же
 * скриптом, который правило СИМПАС и держит (`android-release-gate.mjs
 * names`), — то есть остаются одним источником истины, но не проходят через
 * механизм, который вправе их выбросить.
 *
 * Через outputs ездит только версия: в ней слова «zapiski» нет.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WORKFLOW = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.github/workflows/build-android.yml',
);
const source = readFileSync(WORKFLOW, 'utf8');

describe('имя APK не проходит через outputs job', () => {
  it('файл workflow на месте', () => {
    expect(source).toContain('name: Сборка Android');
  });

  it('job сборки не объявляет apk и artifact своими outputs', () => {
    /* Строка вида `      apk: ${{ steps.collect.outputs.name }}` в блоке
       outputs. Именно её GitHub и выбрасывает. */
    const declared = source
      .split('\n')
      .filter((line) => /^ {6}(apk|artifact):\s/.test(line))
      .map((line) => line.trim());
    expect(declared, 'GitHub выбросит эти outputs: их значение содержит секрет').toEqual([]);
  });

  it('никто не читает needs.build.outputs.apk и .artifact', () => {
    const readers = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /needs\.build\.outputs\.(apk|artifact)\b/.test(line))
      .map(({ line, number }) => `${number}: ${line}`);
    expect(readers, 'здесь придёт пустая строка, а не имя').toEqual([]);
  });

  it('релизный job вычисляет имена тем же скриптом, что держит правило', () => {
    /* Не «переписать имя руками во втором месте»: два места разъезжаются
       молча, и разъехались бы ровно на правиле СИМПАС. */
    expect(source).toMatch(/android-release-gate\.mjs names[\s\S]{0,400}--print/);
  });

  it('версия через outputs ездит по-прежнему', () => {
    /* Она нужна для имени, и в ней секрета нет — иначе выбросило бы и её. */
    expect(source).toMatch(/^ {6}version:\s/m);
    expect(source).toMatch(/needs\.build\.outputs\.version/);
  });
});
