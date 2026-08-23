/**
 * Имена сборок СИМПАС: правило одно на три продукта.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Имена расходились у всех троих, а одно и то же слово транслитерировалось
 * тремя способами сразу: по-своему в каждом репозитории и третьим способом в
 * домене. У соседей в тег релиза подставлялся `github.run_number`, из-за чего
 * росла лестница b19, b20, b23 при неизменной версии продукта.
 *
 * ── Правило ─────────────────────────────────────────────────────────────────
 *
 *   Имя файла:         simpas-<продукт>-<версия>.apk
 *   Тег релиза:        <продукт>-v<версия>
 *   Постоянная ссылка: /updates/latest/<продукт>.apk
 *
 * `<продукт>` — ровно одно из `praktika`, `zapiski`, `momenty`. Здесь —
 * `zapiski`.
 *
 * Приставка `simpas` — по имени СИСТЕМЫ, объединяющей три продукта, а не по
 * имени одного из них: ставить имя одного продукта на файлы остальных значит
 * закреплять ту самую путаницу.
 *
 * Ни хеша коммита, ни номера прогона: человек видит имя в загрузках, и суффикс
 * `-a3f9c21` ему ничего не сообщает. Релиз соответствует ВЕРСИИ, а не прогону:
 * пересобрали ту же версию — обновляется существующий релиз.
 *
 * ── Почему тестом, а не только документом ───────────────────────────────────
 *
 * Записанное правило забывается, падающая сборка — нет.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PRODUCT,
  artifactName,
  bundleName,
  checkArtifactName,
  checkReleaseTag,
  releaseTag,
} from '../scripts/android-release-gate.mjs';

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/android-release-gate.mjs',
);

describe('имена по правилу', () => {
  it('продукт этого репозитория — zapiski', () => {
    expect(PRODUCT).toBe('zapiski');
  });

  it('имя файла: simpas-zapiski-<версия>.apk', () => {
    expect(artifactName({ version: '0.4.2' })).toBe('simpas-zapiski-0.4.2.apk');
  });

  it('отладочная сборка помечена в имени — её нельзя спутать с релизом', () => {
    expect(artifactName({ version: '0.4.2', debug: true })).toBe('simpas-zapiski-0.4.2-debug.apk');
  });

  it('тег релиза: zapiski-v<версия>', () => {
    expect(releaseTag({ version: '0.4.2' })).toBe('zapiski-v0.4.2');
  });
});

describe('сторож имени артефакта', () => {
  it('правильное имя проходит', () => {
    expect(checkArtifactName('simpas-zapiski-0.4.2.apk', { version: '0.4.2' }).ok).toBe(true);
  });

  it('старое имя без приставки — отказ, и сказано какое ожидалось', () => {
    const verdict = checkArtifactName('zapiski-0.4.2.apk', { version: '0.4.2' });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('simpas-zapiski-0.4.2.apk');
  });

  it('чужой продукт в имени не проходит', () => {
    expect(checkArtifactName('simpas-praktika-0.4.2.apk', { version: '0.4.2' }).ok).toBe(false);
    expect(checkArtifactName('simpas-momenty-0.4.2.apk', { version: '0.4.2' }).ok).toBe(false);
  });

  it('хеш коммита в имени — отказ: человеку он ничего не сообщает', () => {
    const verdict = checkArtifactName('simpas-zapiski-0.4.2-a3f9c21.apk', { version: '0.4.2' });
    expect(verdict.ok).toBe(false);
  });

  it('версия в имени обязана совпадать с версией сборки', () => {
    const verdict = checkArtifactName('simpas-zapiski-0.4.1.apk', { version: '0.4.2' });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('0.4.2');
  });
});

describe('сторож тега релиза', () => {
  it('правильный тег проходит', () => {
    expect(checkReleaseTag('zapiski-v0.4.2', { version: '0.4.2' }).ok).toBe(true);
  });

  it('прежний тег вида v0.4.2 — отказ с подсказкой, чем заменить', () => {
    const verdict = checkReleaseTag('v0.4.2', { version: '0.4.2' });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('zapiski-v0.4.2');
  });

  it('номер прогона в теге — отказ: релиз соответствует версии, а не сборке', () => {
    expect(checkReleaseTag('zapiski-v0.4.2-b23', { version: '0.4.2' }).ok).toBe(false);
    expect(checkReleaseTag('zapiski-v0.4.2.b23', { version: '0.4.2' }).ok).toBe(false);
  });

  it('версия в теге обязана совпадать с версией сборки', () => {
    expect(checkReleaseTag('zapiski-v0.4.1', { version: '0.4.2' }).ok).toBe(false);
  });
});

/**
 * Имена считаются ПО ВЕРСИИ, а не передаются между job.
 *
 * Прогон 188 показал, почему это важно: значение одного из секретов
 * репозитория — само слово «zapiski», и GitHub отказывается пропускать через
 * outputs job любое значение, где оно встретилось («Skip output 'apk' since
 * it may contain secret»). Имя файла содержит его всегда. Значит, единственный
 * способ донести имя до релизного job — посчитать его там заново тем же
 * скриптом. Разъехаться два расчёта не могут: расчёт один.
 */
describe('имена печатаются для GITHUB_OUTPUT', () => {
  const print = (args: string[]): string =>
    execFileSync('node', [GATE, 'names', ...args], { encoding: 'utf8' });

  it('имя связки артефактов отличается от имени файла', () => {
    /* В связку кладётся не только APK, но и паспорт сборки, поэтому имя у неё
       своё — и `.apk` в нём не к месту. */
    expect(bundleName({ version: '0.1.0' })).toBe('simpas-zapiski-android-0.1.0');
    expect(bundleName({ version: '0.1.0', debug: true })).toBe('simpas-zapiski-android-0.1.0-debug');
  });

  it('печатает пары ключ=значение, готовые для GITHUB_OUTPUT', () => {
    const out = print(['--version', '0.1.0', '--print']);
    expect(out).toContain('apk=simpas-zapiski-0.1.0.apk');
    expect(out).toContain('bundle=simpas-zapiski-android-0.1.0');
    expect(out).toContain('tag=zapiski-v0.1.0');
    /* Ни одной посторонней строки: вывод уходит в файл, а не человеку. */
    for (const line of out.trim().split('\n')) expect(line).toMatch(/^[a-z]+=\S+$/);
  });

  it('без версии печатать нечего — падает, а не печатает пустое', () => {
    /* Пустая версия дала бы `apk=simpas-zapiski-.apk` — имя, которое выглядит
       как имя. Ровно так и выглядит вычеркнутый output. */
    expect(() => print(['--print'])).toThrow();
  });

  it('отладочная связка помечена и в печати', () => {
    const out = print(['--version', '0.1.0', '--debug', 'true', '--print']);
    expect(out).toContain('apk=simpas-zapiski-0.1.0-debug.apk');
    expect(out).toContain('bundle=simpas-zapiski-android-0.1.0-debug');
  });
});
