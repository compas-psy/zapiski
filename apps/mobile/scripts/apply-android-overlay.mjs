#!/usr/bin/env node
/**
 * Наложить оверлей Android поверх проекта, который сгенерировал
 * `tauri android init`.
 *
 * ── Зачем оверлей ───────────────────────────────────────────────────────────
 *
 * `src-tauri/gen/android` — **сгенерированный** проект Gradle (он и в
 * `.gitignore`): его создаёт CLI по своему шаблону, вместе с `gradlew`,
 * `buildSrc` и бинарным `gradle-wrapper.jar`. Хранить его в репозитории значит
 * хранить чужой артефакт и ловить конфликты при каждом обновлении Tauri.
 *
 * Поэтому в git лежит только то, что написали мы: `apps/mobile/android/**` —
 * Kotlin-код оболочки и ресурсы. Этот скрипт копирует их в сгенерированный
 * проект и дописывает в манифест то, чего в шаблоне быть не может:
 * разрешения, share-target, плитку Quick Settings, FileProvider и виджеты.
 *
 * ── Почему манифест патчится, а не заменяется ───────────────────────────────
 *
 * Шаблон Tauri задаёт активность, тему, `usesCleartextTraffic` и прочее, что
 * меняется от версии к версии CLI. Полная замена файла означала бы, что при
 * обновлении Tauri мы молча откатываем его изменения. Патч добавляет своё и
 * не трогает чужое; повторный запуск ничего не дублирует (блок помечен
 * комментариями-маркерами и заменяется целиком).
 *
 * Запуск:
 *   node scripts/apply-android-overlay.mjs             — наложить оверлей
 *   node scripts/apply-android-overlay.mjs --self-test — проверить патч на
 *                                                        эталонном манифесте
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, '..');
const OVERLAY_DIR = join(APP_DIR, 'android', 'app', 'src', 'main');
const GENERATED_DIR = join(APP_DIR, 'src-tauri', 'gen', 'android');
const GENERATED_MAIN = join(GENERATED_DIR, 'app', 'src', 'main');

const BEGIN = '<!-- BEGIN zapiski overlay: apps/mobile/scripts/apply-android-overlay.mjs -->';
const END = '<!-- END zapiski overlay -->';

/** Разрешения, без которых оболочка не работает. */
const PERMISSIONS = [
  // Фид обновлений и загрузка APK.
  'android.permission.INTERNET',
  // Хэптика (BEHAVIOR §0) там, где нет отклика через View.
  'android.permission.VIBRATE',
  // Установка скачанного обновления системным установщиком.
  'android.permission.REQUEST_INSTALL_PACKAGES',
];

/** Всё, что добавляется внутрь <application>. */
const APPLICATION_CHILDREN = `
    <!--
      Приём системного «Поделиться» (BEHAVIOR §8). Активность невидима и
      живёт миллисекунды: она кладёт содержимое в очередь и открывает
      приложение, а модалку с превью рисует packages/app.
    -->
    <activity
        android:name=".ShareActivity"
        android:exported="true"
        android:excludeFromRecents="true"
        android:noHistory="true"
        android:taskAffinity=""
        android:theme="@android:style/Theme.Translucent.NoTitleBar">
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="text/plain" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/*" />
        </intent-filter>
        <intent-filter>
            <action android:name="android.intent.action.SEND_MULTIPLE" />
            <category android:name="android.intent.category.DEFAULT" />
            <data android:mimeType="image/*" />
        </intent-filter>
    </activity>

    <!-- Плитка Quick Settings — эквивалент быстрой заметки (ТЗ §5.4). -->
    <service
        android:name=".QuickNoteTileService"
        android:exported="true"
        android:icon="@drawable/ic_pen"
        android:label="@string/tile_quick_note"
        android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
        <intent-filter>
            <action android:name="android.service.quicksettings.action.QS_TILE" />
        </intent-filter>
    </service>

    <!--
      FileProvider отдаёт системному установщику скачанный APK.
      Область — только cache/updates (res/xml/file_provider_paths.xml):
      ни vault, ни ключи биометрии наружу не выдаются.

      Имя класса — СВОЙ подкласс UpdatesFileProvider, а не
      androidx.core.content.FileProvider. Причины две, обе обязательные:
        1) шаблон Tauri уже объявляет провайдер с именем androidx-класса,
           и второе объявление с тем же android:name роняет манифест-мержер
           («Element provider#… duplicated»);
        2) очевидная альтернатива — слить оба объявления, перечислив
           authorities через `;` — собирается, но РАСШИРЯЕТ область: у шаблона
           в путях стоят <external-path path="."/> и <cache-path path="."/>,
           то есть внешний каталог и кеш целиком. Установщику это не нужно.
      Подкласс снимает конфликт имён и сохраняет узкую область.
    -->
    <provider
        android:name=".UpdatesFileProvider"
        android:authorities="\${applicationId}.updates"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_provider_paths" />
    </provider>

    <!-- Виджеты (BEHAVIOR §8). Обновление — по данным, не по таймеру. -->
    <receiver
        android:name=".QuickNoteWidget"
        android:exported="false"
        android:label="@string/widget_quick_note">
        <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
        </intent-filter>
        <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/widget_quick_note" />
    </receiver>

    <receiver
        android:name=".RecentWidget"
        android:exported="false"
        android:label="@string/widget_recent">
        <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
        </intent-filter>
        <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/widget_recent" />
    </receiver>

    <receiver
        android:name=".PinnedWidget"
        android:exported="false"
        android:label="@string/widget_pinned">
        <intent-filter>
            <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
        </intent-filter>
        <meta-data
            android:name="android.appwidget.provider"
            android:resource="@xml/widget_pinned" />
    </receiver>

    <!--
      Тапы по виджетам: отметка чекбокса, открытие заметки, быстрая заметка.
      Приёмник не экспортирован — намерения приходят только от наших же
      PendingIntent.
    -->
    <receiver
        android:name=".ZapiskiWidgetReceiver"
        android:exported="false">
        <intent-filter>
            <action android:name="ru.cmpas.zapiski.WIDGET_TOGGLE" />
            <action android:name="ru.cmpas.zapiski.WIDGET_OPEN" />
            <action android:name="ru.cmpas.zapiski.WIDGET_QUICK_NOTE" />
        </intent-filter>
    </receiver>
`;

/**
 * Патч манифеста. Чистая функция: её и проверяет `--self-test`.
 */
export function patchManifest(source) {
  let manifest = source;

  // 1. Свой блок мог остаться от прошлого запуска — убираем целиком вместе с
  //    отступом и собственным переводом строки. Тогда повторный запуск даёт
  //    ровно тот же файл (это проверяет самопроверка).
  const previous = new RegExp(
    `[ \\t]*${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}[ \\t]*\\n?`,
    'g',
  );
  manifest = manifest.replace(previous, '');

  // 2. Разрешения — перед <application>, если их ещё нет.
  const missing = PERMISSIONS.filter(
    (name) => !manifest.includes(`android:name="${name}"`),
  );
  if (missing.length > 0) {
    const block = missing
      .map((name) => `    <uses-permission android:name="${name}" />`)
      .join('\n');
    manifest = insertBefore(manifest, /<application\b/, `${BEGIN}\n${block}\n    ${END}\n    `);
  }

  // 3. Свой Application-класс: он знает текущую активность и контекст.
  manifest = setApplicationName(manifest, '.ZapiskiApplication');

  // 4. Резервное копирование в чужое облако выключено: авто-бэкап Android
  //    отправил бы `.md` пользователя в Google Drive, а продукт обещает
  //    обратное (ТЗ §6, «серверы и данные в РФ»).
  manifest = setApplicationAttribute(manifest, 'android:allowBackup', 'false');

  // 5. Наши компоненты — перед </application>.
  manifest = insertBefore(
    manifest,
    /<\/application>/,
    `${BEGIN}\n${APPLICATION_CHILDREN}    ${END}\n    `,
  );

  return manifest;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Границы XML-комментариев. Нужны, чтобы патч не полез внутрь комментария:
 * в шаблоне (и уж точно в нашем эталоне) слово `<application` встречается в
 * пояснительном тексте, а вставка туда рвёт документ.
 */
function commentRanges(text) {
  const ranges = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start === -1) break;
    const end = text.indexOf('-->', start + 4);
    const stop = end === -1 ? text.length : end + 3;
    ranges.push([start, stop]);
    from = stop;
  }
  return ranges;
}

/** Первое совпадение вне комментариев. */
function findOutsideComments(text, pattern) {
  const ranges = commentRanges(text);
  const search = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  let match;
  while ((match = search.exec(text)) !== null) {
    const inside = ranges.some(([from, to]) => match.index >= from && match.index < to);
    if (!inside) return match;
  }
  return null;
}

function insertBefore(text, pattern, insertion) {
  const match = findOutsideComments(text, pattern);
  if (match === null) {
    throw new Error(`в манифесте не найден ${pattern}`);
  }
  return text.slice(0, match.index) + insertion + text.slice(match.index);
}

/** Прочитать открывающий тег <application …> целиком. */
function applicationTag(manifest) {
  const match = findOutsideComments(manifest, /<application\b[^>]*>/);
  if (match === null) {
    throw new Error('в манифесте нет <application>');
  }
  return { text: match[0], index: match.index };
}

function setApplicationName(manifest, value) {
  return setApplicationAttribute(manifest, 'android:name', value);
}

function setApplicationAttribute(manifest, attribute, value) {
  const tag = applicationTag(manifest);
  const existing = new RegExp(`\\s${escapeRegExp(attribute)}="[^"]*"`);
  const replacement = ` ${attribute}="${value}"`;

  const updated = existing.test(tag.text)
    ? tag.text.replace(existing, replacement)
    : tag.text.replace(/<application\b/, `<application${replacement}`);

  return manifest.slice(0, tag.index) + updated + manifest.slice(tag.index + tag.text.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Наложение
// ─────────────────────────────────────────────────────────────────────────────

function apply() {
  if (!existsSync(GENERATED_DIR)) {
    console.error(
      `apply-android-overlay: нет ${GENERATED_DIR}.\n` +
        'Сначала выполните `pnpm --filter @zapiski/mobile android:init` ' +
        '(нужны Android SDK и NDK).',
    );
    process.exit(2);
  }

  // Kotlin и ресурсы. Не `--delete`: в сгенерированном проекте есть свои
  // файлы (MainActivity, mipmap-иконки, темы), и сносить их нельзя.
  for (const part of ['java', 'res']) {
    const from = join(OVERLAY_DIR, part);
    const to = join(GENERATED_MAIN, part);
    if (!existsSync(from)) continue;
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true });
    console.log(`оверлей: ${part} → ${to}`);
  }

  const manifestPath = join(GENERATED_MAIN, 'AndroidManifest.xml');
  const source = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, patchManifest(source), 'utf8');
  console.log(`оверлей: манифест пропатчен → ${manifestPath}`);

  // FileProvider приходит из androidx.core, а тот — транзитивно из appcompat,
  // который есть в шаблоне Tauri. Если шаблон изменится, сборка упадёт на
  // непонятной ошибке компиляции; лучше сказать об этом заранее.
  const gradle = join(GENERATED_DIR, 'app', 'build.gradle.kts');
  if (existsSync(gradle) && !readFileSync(gradle, 'utf8').includes('appcompat')) {
    console.log(
      '::warning::в app/build.gradle.kts нет androidx.appcompat — ' +
        'androidx.core.content.FileProvider может не разрешиться',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Самопроверка
// ─────────────────────────────────────────────────────────────────────────────

/** Что обязано оказаться в манифесте после патча. */
const EXPECTATIONS = [
  ['разрешение INTERNET', 'android:name="android.permission.INTERNET"'],
  ['разрешение VIBRATE', 'android:name="android.permission.VIBRATE"'],
  ['разрешение REQUEST_INSTALL_PACKAGES', 'android:name="android.permission.REQUEST_INSTALL_PACKAGES"'],
  ['свой Application', 'android:name=".ZapiskiApplication"'],
  ['выключенный авто-бэкап', 'android:allowBackup="false"'],
  ['share-target: активность', 'android:name=".ShareActivity"'],
  ['share-target: SEND', 'android.intent.action.SEND'],
  ['share-target: SEND_MULTIPLE', 'android.intent.action.SEND_MULTIPLE'],
  ['share-target: текст', 'android:mimeType="text/plain"'],
  ['share-target: картинка', 'android:mimeType="image/*"'],
  ['плитка Quick Settings', 'android.service.quicksettings.action.QS_TILE'],
  ['FileProvider', '.UpdatesFileProvider'],
  ['FileProvider: authorities', 'android:authorities="${applicationId}.updates"'],
  ['FileProvider: пути', '@xml/file_provider_paths'],
  ['виджет «Записать»', 'android:name=".QuickNoteWidget"'],
  ['виджет «Последние»', 'android:name=".RecentWidget"'],
  ['виджет «Закреплённая»', 'android:name=".PinnedWidget"'],
  ['приёмник тапов', 'android:name=".ZapiskiWidgetReceiver"'],
  ['сохранена активность Tauri', 'android:name=".MainActivity"'],
  ['сохранён LAUNCHER', 'android.intent.category.LAUNCHER'],
];

function selfTest() {
  const fixture = join(SCRIPT_DIR, 'fixtures', 'AndroidManifest.generated.xml');
  const source = readFileSync(fixture, 'utf8');

  const once = patchManifest(source);
  // Идемпотентность: повторное наложение обязано давать тот же результат,
  // иначе второй запуск сборки удвоит receiver'ы и манифест не соберётся.
  const twice = patchManifest(once);

  const problems = [];
  for (const [what, needle] of EXPECTATIONS) {
    if (!once.includes(needle)) problems.push(`не добавлено: ${what} (${needle})`);
  }
  if (once !== twice) problems.push('патч не идемпотентен: второй запуск меняет манифест');

  // Well-formed XML проверяем настоящим парсером, если он есть в системе.
  const temporary = mkdtempSync(join(tmpdir(), 'zapiski-manifest-'));
  const target = join(temporary, 'AndroidManifest.xml');
  writeFileSync(target, twice, 'utf8');
  try {
    execFileSync('xmllint', ['--noout', target], { stdio: 'pipe' });
    console.log('xmllint: манифест после патча — валидный XML');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('xmllint не найден — проверка XML пропущена');
    } else {
      problems.push(`манифест после патча не валиден: ${String(error.stderr ?? error)}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error('apply-android-overlay: самопроверка не прошла');
    for (const problem of problems) console.error(`  · ${problem}`);
    process.exit(1);
  }

  console.log(`apply-android-overlay: самопроверка пройдена, проверок: ${EXPECTATIONS.length + 2}`);
}

// Запускаемся только как программа. Импорт (например, из теста) обязан
// получить чистые функции и ничего не делать с диском.
const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [, , flag] = process.argv;
  if (flag === '--self-test') {
    selfTest();
  } else if (flag === undefined) {
    apply();
  } else {
    console.error(`apply-android-overlay: неизвестный аргумент ${flag}`);
    process.exit(2);
  }
}
