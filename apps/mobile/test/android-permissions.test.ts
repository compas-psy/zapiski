/**
 * Разрешения Android: список в репозитории — единственный источник истины.
 *
 * ── Что случилось ────────────────────────────────────────────────────────────
 *
 * Play Protect блокировал установку и показывал второе окно «всё равно
 * установить». Причина — `REQUEST_INSTALL_PACKAGES`: этим разрешением
 * приложение объявляет себя установщиком ДРУГИХ приложений, и это ровно тот
 * признак, по которому ловят дропперов. Сравнение с соседями подтверждает:
 * МОМЕНТЫ (только INTERNET) и ПРАКТИКА (RECORD_AUDIO) проверку проходят молча.
 *
 * Разрешение было нужно самоустановке обновлений: приложение качало APK и
 * отдавало его системному установщику. Теперь оно открывает ссылку на APK во
 * внешнем браузере, а «из неизвестных источников» система спрашивает у
 * браузера. Два тапа вместо одного — несопоставимо дешевле, чем блокировка на
 * КАЖДОЙ установке.
 *
 * ── Почему список отдельным файлом ───────────────────────────────────────────
 *
 * Раньше разрешения жили внутри `apply-android-overlay.mjs`, среди двухсот
 * строк патча манифеста. Добавить туда строку — правка скрипта сборки, её не
 * видно в обзоре как решение. Отдельный файл делает добавление разрешения
 * сознательным действием: он маленький, он весь про разрешения, и его
 * изменение видно в диффе первым.
 *
 * Тот же файл сверяется с ГОТОВЫМ пакетом в CI. Шаблон манифеста и итоговый
 * APK — разные вещи: Tauri генерирует манифест сам, и разрешение может
 * приехать из зависимости, которую никто не звал.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parsePermissionList, permissionsGate } from '../scripts/android-release-gate.mjs';
import { patchedManifest } from '../scripts/apply-android-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = path.join(ROOT, 'android-permissions.txt');

const allowed = parsePermissionList(readFileSync(LIST, 'utf8'));
const names = allowed.map((entry) => entry.name);

describe('список разрешений в репозитории', () => {
  it('разобрался и не пуст', () => {
    expect(allowed.length).toBeGreaterThan(0);
  });

  it('REQUEST_INSTALL_PACKAGES в нём нет — из-за него и блокировали', () => {
    expect(names).not.toContain('android.permission.REQUEST_INSTALL_PACKAGES');
  });

  it('в нём ровно те четыре, для которых нашлось живое применение', () => {
    expect([...names].sort()).toEqual([
      'android.permission.INTERNET',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      'android.permission.VIBRATE',
    ]);
  });

  it('USE_FINGERPRINT ограничен девятым Android — на новых он не нужен', () => {
    const fingerprint = allowed.find((entry) => entry.name.endsWith('USE_FINGERPRINT'));
    expect(fingerprint?.maxSdkVersion).toBe(28);
  });

  it('у каждого разрешения есть объяснение рядом — пустая строка не проходит', () => {
    for (const entry of allowed) {
      expect(entry.why, `${entry.name}: нет объяснения`).toBeTruthy();
    }
  });
});

describe('сверка готового пакета со списком', () => {
  it('совпало — пропускаем', () => {
    const verdict = permissionsGate(names, allowed);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('в пакете лишнее разрешение — сборка падает и называет его', () => {
    const verdict = permissionsGate([...names, 'android.permission.REQUEST_INSTALL_PACKAGES'], allowed);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('REQUEST_INSTALL_PACKAGES');
  });

  it('в пакете нет объявленного — тоже отказ: список обязан описывать пакет', () => {
    const verdict = permissionsGate(
      names.filter((name) => !name.endsWith('VIBRATE')),
      allowed,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('VIBRATE');
  });

  it('порядок и повторы значения не имеют — сравниваются множества', () => {
    const shuffled = [...names].reverse().concat(names[0] ?? '');
    expect(permissionsGate(shuffled, allowed).ok).toBe(true);
  });
});

describe('манифест после патча описывает ровно список', () => {
  const patched = patchedManifest();

  it('в манифесте нет REQUEST_INSTALL_PACKAGES', () => {
    expect(patched).not.toContain('REQUEST_INSTALL_PACKAGES');
  });

  it('в манифесте ровно те разрешения, что в списке, и ни одного лишнего', () => {
    const inManifest = [...patched.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect([...new Set(inManifest)].sort()).toEqual([...names].sort());
  });

  it('maxSdkVersion доехал до манифеста, а не потерялся при переносе в файл', () => {
    expect(patched).toContain(
      'android:name="android.permission.USE_FINGERPRINT" android:maxSdkVersion="28"',
    );
  });
});

describe('самоустановки не осталось ни в одном слое', () => {
  const FILES = [
    'android/app/src/main/java/ru/cmpas/zapiski/Updates.kt',
    'android/app/src/main/java/ru/cmpas/zapiski/NativeBridge.kt',
    'src-tauri/src/updater.rs',
    'src-tauri/src/android.rs',
    'src-tauri/src/lib.rs',
    'src/platform/updater.ts',
    'src/platform/ipc.ts',
  ];

  /*
   * Запрещены РАБОЧИЕ имена, а не упоминание разрешения.
   *
   * Само `REQUEST_INSTALL_PACKAGES` в исходниках встречается — в объяснениях,
   * почему его убрали. Это не остаток, а единственное, что удержит следующего
   * агента от «а давайте вернём самоустановку, так удобнее»: причина записана
   * рядом с местом, где её захочется нарушить. Строгий запрет на подстроку
   * стоит там, где она может быть только настоящей: в списке разрешений и в
   * манифесте после патча (проверки выше).
   *
   * А вот эти имена в комментарии не появятся: каждое — вызов или объявление.
   */
  const DEAD = [
    'canRequestPackageInstalls',
    'install_apk',
    'installApk',
    'UpdatesFileProvider',
    'ACTION_MANAGE_UNKNOWN_APP_SOURCES',
    'vnd.android.package-archive',
    'updater_download_install',
  ];

  it.each(FILES)('в %s нет вызовов установщика пакетов', (file) => {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const needle of DEAD) {
      expect(source, `${file}: осталось ${needle}`).not.toContain(needle);
    }
  });

  it('в скрипте патча манифеста разрешения нет даже строкой', () => {
    const source = readFileSync(path.join(ROOT, 'scripts/apply-android-overlay.mjs'), 'utf8');
    expect(source).not.toContain('REQUEST_INSTALL_PACKAGES');
  });

  it('мёртвые файлы удалены', () => {
    for (const file of [
      'android/app/src/main/java/ru/cmpas/zapiski/UpdatesFileProvider.kt',
      'android/app/src/main/res/xml/file_provider_paths.xml',
    ]) {
      expect(existsSync(path.join(ROOT, file)), `${file} ещё на месте`).toBe(false);
    }
  });
});
