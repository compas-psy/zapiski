/**
 * Сторож незакрытых импортов в Kotlin-файлах оболочки.
 *
 * Зачем. Kotlin у нас компилируется ТОЛЬКО в CI: Android SDK на машине
 * разработки нет и не будет. Поэтому забытый импорт обнаруживается через
 * четыре минуты сборки, в конце длинного лога, а хвост лога занят уборкой —
 * то есть ровно там, где его труднее всего заметить. Так и вышло: пять
 * прогонов подряд падали на
 *
 *   NativeBridge.kt:255:22 Unresolved reference: Intent
 *
 * потому что в файле не было `import android.content.Intent`.
 *
 * Этот скрипт — не компилятор и не претендует. Он проверяет ровно одно:
 * каждое имя с заглавной буквы, использованное как `Имя(` или `Имя.`, должно
 * быть либо импортировано, либо объявлено здесь же, либо лежать в нашем
 * пакете, либо входить в короткий список того, что доступно без импорта.
 * Этого достаточно, чтобы поймать забытый `android.*`, и мало настолько,
 * чтобы не выдумывать ложных тревог.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../android', import.meta.url));

/**
 * Доступно без импорта: пакет `kotlin.*` и `java.lang.*` подключаются
 * автоматически, плюс то, что Kotlin считает встроенным.
 */
const IMPLICIT = new Set([
  'Any', 'Array', 'Boolean', 'Byte', 'ByteArray', 'Char', 'CharArray', 'CharSequence',
  'Comparable', 'Double', 'Error', 'Exception', 'Float', 'Int', 'IntArray', 'Iterable',
  'Iterator', 'Lazy', 'List', 'Long', 'LongArray', 'Map', 'MutableList', 'MutableMap',
  'MutableSet', 'Nothing', 'Number', 'Pair', 'Result', 'RuntimeException', 'Sequence',
  'Set', 'Short', 'String', 'StringBuilder', 'Throwable', 'Triple', 'Unit',
  'IllegalArgumentException', 'IllegalStateException', 'IndexOutOfBoundsException',
  'NullPointerException', 'NumberFormatException', 'SecurityException', 'System',
  'Math', 'Thread', 'Runnable', 'Object', 'Class', 'Boolean', 'Regex', 'JvmStatic',
  'JvmField', 'Volatile', 'Suppress', 'Deprecated', 'Throws', 'Synchronized',
  /* `R` генерируется сборкой в наш же пакет — импорта не требует. */
  'R',
  /* kotlin.text.Charsets — часть автоматически подключённого kotlin.*. */
  'Charsets',
]);

/**
 * Имена, видимые внутри объекта-наследника без импорта: вложенные интерфейсы
 * базового класса. Список короткий и растёт только по факту.
 */
const INHERITED = new Set(['ActivityLifecycleCallbacks']);

/**
 * Классы, которые `tauri android init` кладёт в НАШ пакет: в репозитории их
 * нет (сгенерированный проект в `.gitignore`), а в сборке они рядом и видны
 * без импорта. Список короткий и растёт только по факту.
 */
const GENERATED = new Set(['TauriActivity']);

/** Файлы нашей оболочки. Сгенерированное Tauri сюда не попадает. */
function kotlinFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...kotlinFiles(path));
    else if (entry.endsWith('.kt')) out.push(path);
  }
  return out;
}

const files = kotlinFiles(ROOT);

/** Всё, что объявлено в нашем пакете: такие имена видны без импорта. */
const ours = new Set();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/^\s*(?:\w+\s+)*?(?:class|object|interface|enum class)\s+(\w+)/gm)) {
    ours.add(match[1]);
  }
}

const problems = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');

  /* Файл, объявленный в чужом пакете фреймворка (`package android.print`),
     видит его содержимое без импорта — так и задумано, туда кладут классы
     ради доступа к package-private API. Проверять там нечего. */
  if (/^\s*package\s+android\./m.test(source)) continue;

  /* Строки и комментарии выбрасываем: `Intent` в комментарии импорта не требует. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

  const imported = new Set();
  for (const match of code.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
    imported.add(match[2] ?? match[1].split('.').pop());
  }
  const declaredHere = new Set();
  for (const match of code.matchAll(/\b(?:class|object|interface|enum class)\s+(\w+)/g)) {
    declaredHere.add(match[1]);
  }

  /* Имена, объявленные в самом файле: константы, поля, функции. Без них
     сторож ругался бы на собственные `const val PAGE_WIDTH_PT`. */
  for (const match of code.matchAll(/\b(?:const\s+)?(?:val|var|fun)\s+([A-Z][A-Za-z0-9_]*)/g)) {
    declaredHere.add(match[1]);
  }

  const used = new Set();
  /* Берём только ГОЛОВУ цепочки: в `PrintAttributes.MediaSize.ISO_A4`
     импорта требует `PrintAttributes`, а не звенья после точки. Поэтому
     совпадение с точкой перед именем пропускаем. */
  for (const match of code.matchAll(/(^|[^.\w])([A-Z][A-Za-z0-9_]*)\s*[(.]/g)) used.add(match[2]);
  /* `: Имя` и `is Имя` — типы в сигнатурах и проверках, тоже голова цепочки. */
  for (const match of code.matchAll(/(?::|\bis)\s+([A-Z][A-Za-z0-9_]*)/g)) used.add(match[1]);

  for (const name of used) {
    /* Однобуквенные — параметры-обобщения (`fun <T> …`), а не типы. */
    if (name.length === 1) continue;
    if (INHERITED.has(name) || GENERATED.has(name)) continue;
    if (imported.has(name) || declaredHere.has(name) || ours.has(name) || IMPLICIT.has(name)) continue;
    problems.push(`${relative(process.cwd(), file)}: имя ${name} используется, но не импортировано`);
  }
}

if (problems.length > 0) {
  console.error('kotlin-imports: найдены неразрешённые имена');
  for (const problem of problems.sort()) console.error(`  · ${problem}`);
  console.error(
    '\nKotlin компилируется только в CI, и такая ошибка стоит четырёх минут сборки.\n' +
      'Добавьте import — или, если имя доступно без него, впишите его в IMPLICIT этого скрипта.',
  );
  process.exit(1);
}
console.log(`kotlin-imports: чисто — проверено файлов: ${files.length}`);
