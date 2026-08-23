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
import { parsePermissionList } from './android-release-gate.mjs';
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

/**
 * Разрешения, без которых оболочка не работает.
 *
 * Строка — просто имя; объект — имя с ограничением по версии (`maxSdkVersion`).
 */
/*
 * Разрешения берутся из `apps/mobile/android-permissions.txt`, а не хранятся
 * здесь копией.
 *
 * Раньше список жил прямо в этом файле, среди двухсот строк патча манифеста.
 * Добавить туда строку — правка скрипта сборки: в обзоре она не читается как
 * решение «мы просим у человека ещё одно разрешение». Именно так тут и
 * задержалось разрешение установщика пакетов, из-за которого Play Protect
 * блокировал КАЖДУЮ установку (история — в шапке android-permissions.txt).
 * Отдельный файл делает добавление сознательным действием, и с ним же CI
 * сверяет ГОТОВЫЙ APK.
 */
const PERMISSIONS = parsePermissionList(
  readFileSync(join(SCRIPT_DIR, '..', 'android-permissions.txt'), 'utf8'),
  // В манифест кладём только системные. Разрешения из собственного
  // пространства имён (`ru.cmpas.zapiski.*`) объявляет библиотека, которая их
  // и завела; в списке они есть, потому что присутствуют в ПАКЕТЕ, но писать
  // их руками — значит объявить одно и то же дважды и уронить манифест-мержер.
).filter((entry) => entry.name.startsWith('android.permission.'));

/**
 * Возможности устройства, которые нам полезны, но не обязательны.
 *
 * `required="false"` здесь принципиально: с `true` Play спрятал бы приложение
 * от планшетов без сканера отпечатка, хотя шифрование там работает паролем и
 * ничего не теряет.
 */
const FEATURES = [
  'android.hardware.biometrics',
  'android.hardware.fingerprint',
];

/**
 * `<queries>` — кого наше приложение имеет право ВИДЕТЬ (Android 11+).
 *
 * С Android 11 приложение по умолчанию не видит чужие пакеты. Для «Поделиться»
 * это значит вот что: `Intent.createChooser` резолвит цели заранее, и когда
 * видимых целей нет, попытка открыть окно кончается `ActivityNotFoundException`
 * — на телефоне, где мессенджеров и почты полно.
 *
 * Ровно это и увидел заказчик: тап по «Поделиться» и тост «ни одно приложение
 * не принимает текст». Приложения были; их не было видно НАМ.
 *
 * Объявляем ровно то, что отправляем, — отправку текста. Права «видеть все
 * пакеты» (`QUERY_ALL_PACKAGES`) не просим: это разрешение под особым надзором
 * магазинов, и для одной кнопки оно несоразмерно.
 */
const QUERIES = `
    <queries>
        <intent>
            <action android:name="android.intent.action.SEND" />
            <data android:mimeType="text/plain" />
        </intent>
    </queries>`;

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

    <!--
      Возврат после входа (ТЗ §5.5). Активность невидима, как и share-target,
      и по той же причине: ссылка поднимает приложение с нуля, а очередь
      переживает холодный старт.

      Три фильтра:
        1) своя схема zapiski:// — ею сервер уводит браузер обратно
           в приложение (AUTH_SUCCESS_REDIRECT);
        2) App Link на /auth/… — тот же адрес открывается приложением, а не
           браузером, если владение доменом подтверждено assetlinks.json;
        3) App Link на сам адрес из письма. Сервер ждёт к токену device_id,
           а знает его приложение, а не браузер, — поэтому переход по ссылке
           обязан попасть в приложение того устройства, которое её и просило.
           Не подтверждено владение доменом — откроется браузер, и обмен
           сделает веб-оболочка. Ни один путь не теряется.
    -->
    <activity
        android:name=".AuthActivity"
        android:exported="true"
        android:excludeFromRecents="true"
        android:noHistory="true"
        android:taskAffinity=""
        android:theme="@android:style/Theme.Translucent.NoTitleBar">
        <intent-filter>
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="zapiski" />
        </intent-filter>
        <intent-filter android:autoVerify="true">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data
                android:scheme="https"
                android:host="zapiski.cmpas.ru"
                android:pathPrefix="/auth" />
            <data
                android:scheme="https"
                android:host="zapiski.cmpas.ru"
                android:path="/api/v1/auth/magic-link/callback" />
        </intent-filter>
    </activity>

    <!--
      Системный выбор папки (ТЗ §4.1 п. 1: LocalFolder — в т.ч. папка, которую
      синкает сторонний клиент). Невидимая активность: диалог рисует система,
      а результат нужно принять в onActivityResult — переопределять для этого
      сгенерированную MainActivity значило бы форкать шаблон Tauri.

      Она не exported: её зовём только мы, снаружи она никому не нужна.
    -->
    <activity
        android:name=".FolderPickActivity"
        android:exported="false"
        android:excludeFromRecents="true"
        android:taskAffinity=""
        android:theme="@android:style/Theme.Translucent.NoTitleBar" />

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
      Второй FileProvider — картинки заметки, которые уезжают вместе с ней
      через «Поделиться». Область — только cache/share
      (res/xml/share_file_paths.xml).

      Почему не расширить область первого: у них разные получатели. Первый
      отдаёт APK системному установщику, второй — вложение чужому мессенджеру,
      и общий каталог означал бы, что каждый из них видит чужое. Отдельные
      authorities стоят десяти строк манифеста и снимают вопрос целиком.
    -->
    <provider
        android:name=".ShareFileProvider"
        android:authorities="\${applicationId}.share"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/share_file_paths" />
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

  // 2. Разрешения и возможности — перед <application>, если их ещё нет.
  const declarations = [
    ...PERMISSIONS.map(({ name, maxSdkVersion }) => ({
        name,
        line:
          maxSdkVersion === undefined
            ? `    <uses-permission android:name="${name}" />`
            : `    <uses-permission android:name="${name}" android:maxSdkVersion="${maxSdkVersion}" />`,
    })),
    ...FEATURES.map((name) => ({
      name,
      line: `    <uses-feature android:name="${name}" android:required="false" />`,
    })),
  ];
  const missing = declarations.filter(({ name }) => !manifest.includes(`android:name="${name}"`));
  if (missing.length > 0) {
    const block = missing.map(({ line }) => line).join('\n');
    manifest = insertBefore(manifest, /<application\b/, `${BEGIN}\n${block}\n    ${END}\n    `);
  }

  // 2b. Кого мы имеем право видеть (Android 11+). Без этого блока системное
  //     «Поделиться» не находит ни одной цели — см. комментарий у QUERIES.
  if (!manifest.includes('<queries>')) {
    manifest = insertBefore(
      manifest,
      /<application\b/,
      `${BEGIN}${QUERIES}\n    ${END}\n    `,
    );
  }

  // 3. Свой Application-класс: он знает текущую активность и контекст.
  manifest = setApplicationName(manifest, '.ZapiskiApplication');

  // 4. Резервное копирование в чужое облако выключено: авто-бэкап Android
  //    отправил бы `.md` пользователя в Google Drive, а продукт обещает
  //    обратное (ТЗ §6, «серверы и данные в РФ»).
  manifest = setApplicationAttribute(manifest, 'android:allowBackup', 'false');

  // 5. Клавиатура ужимает окно, а не ложится поверх него.
  //
  //    Без этого атрибута WebView не сообщает об изменении видимой области, и
  //    `visualViewport` в вебе остаётся прежней высоты: тулбар редактора с
  //    жирным, курсивом и списком уходит ПОД клавиатуру. Вторая половина
  //    решения — `packages/app/src/lib/keyboard.ts`; нужны обе.
  manifest = setMainActivitySoftInput(manifest);

  // 6. Рисуем под вырезом — иначе система не сообщает WebView о врезках, и
  //    `env(safe-area-inset-top)` в CSS остаётся нулём при том, что окно
  //    занимает верх экрана. Вторая половина решения — отступы в
  //    `packages/app/src/styles/app.css`; нужны обе.
  manifest = setMainActivityCutoutMode(manifest);

  // 7. Наши компоненты — перед </application>.
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
 * Атрибут на активность Tauri.
 *
 * Правится существующий тег, а не добавляется свой: активность генерирует
 * шаблон Tauri, и вторая с тем же именем — это ошибка сборки. Повторный вызов
 * ничего не меняет: если атрибут уже стоит, тег возвращается как есть.
 */
export function setMainActivityAttribute(manifest, name, value) {
  return manifest.replace(
    /<activity\b[^>]*android:name="\.MainActivity"[^>]*?\s*(\/?)>/,
    (whole, selfClosing) => {
      if (whole.includes(`${name}=`)) return whole;
      const head = whole.slice(0, whole.length - (selfClosing ? 2 : 1)).trimEnd();
      return `${head}\n            ${name}="${value}"${selfClosing ? ' />' : '>'}`;
    },
  );
}

/** `android:windowSoftInputMode="adjustResize"` — клавиатура ужимает окно. */
export function setMainActivitySoftInput(manifest) {
  return setMainActivityAttribute(manifest, 'android:windowSoftInputMode', 'adjustResize');
}

/**
 * `android:windowLayoutInDisplayCutoutMode="shortEdges"` — рисуем под вырезом.
 *
 * Без этого атрибута `env(safe-area-inset-top)` в WebView всегда ноль, и
 * никакие отступы в CSS не спасают: система просто не сообщает вырез. При этом
 * окно всё равно занимало верх экрана, и шапка «Все заметки» вставала вплотную
 * к часам и значку батареи — это видно на любом скриншоте с телефона.
 *
 * `shortEdges`, а не `always`: в альбомной ориентации `always` пустил бы текст
 * под боковой вырез, и первая буква строки оказалась бы под ним.
 */
export function setMainActivityCutoutMode(manifest) {
  return setMainActivityAttribute(
    manifest,
    'android:windowLayoutInDisplayCutoutMode',
    'shortEdges',
  );
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

  /*
    Наш `MainActivity.kt` ложится ПОВЕРХ шаблонного — иначе перехватить
    системное «назад» негде: `TauriActivity` выключает у себя обработчик
    (`handleBackNavigation = false`), и жест уходит системе как «закрыть
    приложение». Наш класс наследуется от `TauriActivity`, который генерирует
    сам Tauri, поэтому его пропажа означает смену шаблона — и Kotlin упадёт
    через четыре минуты сборки на невнятной ошибке. Лучше сказать сейчас.
  */
  const base = join(GENERATED_MAIN, 'java', ...'ru.cmpas.zapiski'.split('.'), 'TauriActivity.kt');
  if (!existsSync(base)) {
    console.log(
      '::warning::в сгенерированном проекте нет TauriActivity.kt — ' +
        'проверьте, от чего наследуется MainActivity в новой версии Tauri',
    );
  }

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
  /* Без этой строки диалог биометрии отвечает SecurityException — на главном
     потоке, то есть крахом приложения. Сборка обязана падать, если она уедет. */
  ['разрешение USE_BIOMETRIC', 'android:name="android.permission.USE_BIOMETRIC"'],
  ['разрешение USE_FINGERPRINT для Android 9', 'android:name="android.permission.USE_FINGERPRINT"'],
  ['сканер отпечатка необязателен', 'android:name="android.hardware.fingerprint" android:required="false"'],
  ['свой Application', 'android:name=".ZapiskiApplication"'],
  ['выключенный авто-бэкап', 'android:allowBackup="false"'],
  ['share-target: активность', 'android:name=".ShareActivity"'],
  ['share-target: SEND', 'android.intent.action.SEND'],
  ['share-target: SEND_MULTIPLE', 'android.intent.action.SEND_MULTIPLE'],
  ['share-target: текст', 'android:mimeType="text/plain"'],
  ['share-target: картинка', 'android:mimeType="image/*"'],
  ['выбор папки: активность', 'android:name=".FolderPickActivity"'],
  ['возврат входа: активность', 'android:name=".AuthActivity"'],
  ['возврат входа: схема zapiski://', 'android:scheme="zapiski"'],
  ['возврат входа: App Link на /auth', 'android:pathPrefix="/auth"'],
  ['возврат входа: App Link на ссылку из письма', 'android:path="/api/v1/auth/magic-link/callback"'],
  ['возврат входа: проверка домена', 'android:autoVerify="true"'],
  ['плитка Quick Settings', 'android.service.quicksettings.action.QS_TILE'],
  ['FileProvider вложений', '.ShareFileProvider'],
  ['FileProvider вложений: authorities', 'android:authorities="${applicationId}.share"'],
  ['FileProvider вложений: пути', '@xml/share_file_paths'],
  ['виджет «Записать»', 'android:name=".QuickNoteWidget"'],
  ['виджет «Последние»', 'android:name=".RecentWidget"'],
  ['виджет «Закреплённая»', 'android:name=".PinnedWidget"'],
  ['приёмник тапов', 'android:name=".ZapiskiWidgetReceiver"'],
  ['сохранена активность Tauri', 'android:name=".MainActivity"'],
  /*
    Видимость чужих приложений (Android 11+). Без этого блока системное
    «Поделиться» не находит ни одной цели: заказчик получил тост «ни одно
    приложение не принимает текст» на телефоне, где их полно.
  */
  ['видимость: блок queries', '<queries>'],
  ['видимость: отправка текста', '<action android:name="android.intent.action.SEND" />'],
  ['клавиатура ужимает окно', 'android:windowSoftInputMode="adjustResize"'],
  ['рисуем под вырезом', 'android:windowLayoutInDisplayCutoutMode="shortEdges"'],
  ['сохранён LAUNCHER', 'android.intent.category.LAUNCHER'],
];

/**
 * Манифест-фикстура после патча — для тестов. Самопроверка ниже ищет строки
 * `includes`-ом и лишнего заметить не может; `test/android-permissions.test.ts`
 * сверяет ПОЛНЫЙ состав разрешений, а для этого ему нужен весь текст.
 */
export function patchedManifest() {
  const fixture = join(SCRIPT_DIR, 'fixtures', 'AndroidManifest.generated.xml');
  return patchManifest(readFileSync(fixture, 'utf8'));
}

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
