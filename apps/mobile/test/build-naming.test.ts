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
import { describe, expect, it } from 'vitest';

import {
  PRODUCT,
  artifactName,
  checkArtifactName,
  checkReleaseTag,
  releaseTag,
} from '../scripts/android-release-gate.mjs';

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
