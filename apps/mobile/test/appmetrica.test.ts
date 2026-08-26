/**
 * AppMetrica на Android.
 *
 * ── Почему проверка такая ───────────────────────────────────────────────────
 *
 * Зависимость едет в СГЕНЕРИРОВАННЫЙ `app/build.gradle.kts` (см. шапку
 * `apply-android-overlay.mjs`): файла нет в репозитории, `tauri android init`
 * пишет его заново при каждой сборке. Без патча Gradle-файла Kotlin-код,
 * зовущий `AppMetrica.activate`, не соберётся вовсе — «класс не найден» через
 * несколько минут сборки, ровно то, от чего защищает остальной оверлей.
 *
 * Поэтому `patchGradle` проверяется на эталонном файле точно так же, как
 * `patchManifest` — на эталонном манифесте: наложение идемпотентно, и после
 * него зависимость на месте.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { patchGradle } from '../scripts/apply-android-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GRADLE_FIXTURE = path.join(ROOT, 'scripts/fixtures/build.gradle.kts.generated');

describe('Gradle-файл после патча подключает AppMetrica', () => {
  const source = readFileSync(GRADLE_FIXTURE, 'utf8');
  const once = patchGradle(source);

  it('зависимость добавлена', () => {
    expect(once).toContain('io.appmetrica.analytics:analytics:');
  });

  it('добавлена внутрь блока dependencies, а не куда попало', () => {
    const dependenciesBlock = /dependencies\s*\{[\s\S]*?\n\}/.exec(once)?.[0] ?? '';
    expect(dependenciesBlock, 'блок dependencies не найден').not.toBe('');
    expect(dependenciesBlock).toContain('io.appmetrica.analytics:analytics:');
  });

  it('патч идемпотентен — повторное наложение не дублирует зависимость', () => {
    const twice = patchGradle(once);
    expect(twice).toBe(once);
    expect(twice.match(/io\.appmetrica\.analytics:analytics:/g)?.length).toBe(1);
  });

  it('чужие зависимости шаблона Tauri остались на месте', () => {
    expect(once).toContain('androidx.appcompat:appcompat:');
    expect(once).toContain('androidx.webkit:webkit:');
  });
});

describe('ZapiskiApplication активирует AppMetrica при старте', () => {
  const source = readFileSync(
    path.join(ROOT, 'android/app/src/main/java/ru/cmpas/zapiski/ZapiskiApplication.kt'),
    'utf8',
  );

  it('ключ активации — тот, что выдал Яндекс', () => {
    expect(source).toContain('d15d5479-3420-4deb-b830-ab0b6b08d1c1');
  });

  it('активация вызвана в onCreate, а не только объявлена', () => {
    expect(source).toContain('AppMetrica.activate(');
  });

  it('оба класса SDK импортированы — иначе сборка падает на Unresolved reference', () => {
    expect(source).toContain('import io.appmetrica.analytics.AppMetrica');
    expect(source).toContain('import io.appmetrica.analytics.AppMetricaConfig');
  });
});
