/**
 * Определение источника импорта — по структуре и именам, без сети.
 *
 * ── Почему определяем, а не спрашиваем ──────────────────────────────────────
 *
 * Спецификация дизайна (`docs/design/handoff-import/IMPORT.md` §0.2) запрещает
 * экран выбора источника: ни списка, ни радиокнопок, ни логотипов чужих
 * продуктов. Причина продуктовая: человек, который несёт заметки, часто не
 * знает, «в каком формате» его экспорт, — он знает, из какого приложения ушёл.
 * Спрашивать формат значит перекладывать нашу работу на него.
 *
 * Поэтому источник — вывод из содержимого, и заголовок шага 2 становится
 * утверждением: «Это хранилище Obsidian».
 *
 * ── Порядок проверок важен (§3) ─────────────────────────────────────────────
 *
 * Первое совпадение выигрывает, и порядок не случаен. Хранилище Obsidian тоже
 * состоит из `.md`, а экспорт Notion — тоже; значит общее правило «есть `.md`»
 * обязано стоять последним, иначе оно перехватит всё. `.enex` идёт раньше
 * Bear, потому что выгрузка Evernote может лежать внутри папки с чем угодно.
 *
 * Никакой сети и никакой телеметрии здесь нет и быть не может (§6): ни один
 * байт содержимого не покидает устройство.
 */

/** Что мы поняли про принесённое. */
export type ImportSource = 'obsidian' | 'evernote' | 'bear' | 'notion' | 'markdown' | 'unknown';

/** Доля notion-имён, после которой экспорт считается ноушновским (§3.4). */
const NOTION_SHARE = 0.3;

/**
 * Хвост имени файла у экспорта Notion: пробел и 32 шестнадцатеричных знака.
 *
 * Notion дописывает к каждому имени идентификатор страницы — и к файлам, и к
 * папкам. Это самый надёжный признак: содержимое у него обычный markdown, а
 * структура ничем не отличается от чужой.
 */
const NOTION_TAIL = /[ -][0-9a-f]{32}$/i;

function stemOfName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

function isMarkdownName(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}

function isNotionish(path: string): boolean {
  const parts = path.split('/');
  const file = parts.pop() ?? '';
  /* Хвост бывает и у файла, и у любой папки на пути: «Проект 1f2c…/Задачи
     9ab0….md». Достаточно одного совпадения. */
  if (NOTION_TAIL.test(stemOfName(file))) return true;
  return parts.some((folder) => NOTION_TAIL.test(folder));
}

/**
 * Определить источник по списку путей внутри принесённого.
 *
 * `names` — пути относительно корня папки или архива, со слэшами. Регистр
 * расширений неважен: `.MD` и `.md` встречаются оба.
 */
export function detectImportSource(names: Iterable<string>): ImportSource {
  const paths = [...names].map((name) => name.replace(/\\/g, '/'));

  /* 1. Каталог `.obsidian/` — признак хранилища, а не просто папки с `.md`. */
  if (paths.some((path) => path === '.obsidian' || path.includes('.obsidian/'))) return 'obsidian';

  /* 2. `.enex` — выгрузка Evernote; таких файлов может быть несколько. */
  if (paths.some((path) => /\.enex$/i.test(path))) return 'evernote';

  /* 3. Bear: `.textbundle`/`.bearnote` — пакеты, то есть каталоги с точкой. */
  if (paths.some((path) => /\.(textbundle|bearnote)(\/|$)/i.test(path))) return 'bear';

  /* 4. Notion: считаем долю среди markdown и html — csv у него служебные. */
  const documents = paths.filter((path) => isMarkdownName(path) || /\.html?$/i.test(path));
  if (documents.length > 0) {
    const notionish = documents.filter((path) => isNotionish(path)).length;
    if (notionish / documents.length >= NOTION_SHARE) return 'notion';
  }

  /* 5. Просто папка с markdown — честный фолбэк, он же самый частый. */
  if (paths.some((path) => isMarkdownName(path))) return 'markdown';

  /* 6. Ни одного поддерживаемого файла: шаг 2 скажет «Не удалось прочитать
        это» и предложит выбрать другую папку. */
  return 'unknown';
}

/**
 * Имя целевой папки по умолчанию (§2, шаг 2: «Положить в»).
 *
 * Имя источника, а не «Импорт 2026-08-17»: человек ищет свои заметки по тому
 * имени, которым называл их сам, — «где мой Obsidian».
 */
export function defaultImportFolder(source: ImportSource): string {
  switch (source) {
    case 'obsidian':
      return 'Obsidian';
    case 'bear':
      return 'Bear';
    case 'notion':
      return 'Notion';
    case 'evernote':
      return 'Evernote';
    default:
      return 'Импорт';
  }
}
