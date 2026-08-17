/**
 * Скан перед импортом: что нашли и что при переносе упростится.
 *
 * ── Зачем скан отдельно от импорта ──────────────────────────────────────────
 *
 * Правило спецификации (`docs/design/handoff-import/IMPORT.md` §2): «о потерях
 * сообщаем ДО запуска, а не в отчёте», и показывать блок потерь после старта
 * запрещено. Значит числа и список упрощений обязаны существовать раньше, чем
 * в vault записан первый файл, — иначе человек соглашается вслепую.
 *
 * ── Почему потери — данные, а не строки ─────────────────────────────────────
 *
 * Ядро не знает языка интерфейса и не должно: та же §0.5 требует, чтобы тексты
 * жили в одном месте и совпадали дословно. Поэтому здесь возвращаются
 * структуры с числами (`{ kind: 'notion-databases', count: 12 }`), а фразу
 * «12 баз данных станут таблицами markdown» собирает словарь приложения.
 * Побочная выгода: у сканера нет ни одной строки, которую можно рассинхронить
 * со спецификацией.
 */
import { detectImportSource, defaultImportFolder, type ImportSource } from './detect.js';
import { decode } from './types.js';
import type { ImportBundle } from './types.js';

/** Что упростится при переносе — материал для блока «Что станет проще, чем было». */
export type ImportLoss =
  /** Базы Notion станут markdown-таблицами: виды, фильтры и формулы не переносятся. */
  | { kind: 'notion-databases'; count: number }
  /** Вложенные страницы Notion станут папками с заметкой-обложкой. */
  | { kind: 'notion-subpages' }
  /** Файлы, которые мы не превращаем, а прикладываем как есть. */
  | { kind: 'kept-as-is'; count: number }
  /** Сложная вёрстка таблиц Evernote станет markdown-таблицей. */
  | { kind: 'evernote-tables' }
  /** Рукописные вложения Evernote приложим картинками. */
  | { kind: 'evernote-handwriting'; count: number };

export interface ImportScan {
  source: ImportSource;
  /** Первая плитка: «заметок» — или «страниц» у Notion. */
  documents: number;
  /** Вторая плитка: «вложений». */
  attachments: number;
  /** Третья плитка: «папок» — «баз данных» у Notion, «блокнотов» у Evernote. */
  groups: number;
  /** Сколько занимает принесённое. Показывается рядом с именем источника. */
  bytes: number;
  /** Пусто — блока «Что станет проще, чем было» на экране нет вовсе. */
  losses: ImportLoss[];
  /** Целевая папка по умолчанию: имя источника (§2). */
  folder: string;
}

/** Знакомые расширения вложений: их мы переносим и показываем как вложения. */
const KNOWN_ASSET = /\.(png|jpe?g|gif|webp|svg|pdf|mp3|m4a|ogg|wav|mp4|mov|zip|docx?|xlsx?)$/i;

/**
 * Просканировать принесённое.
 *
 * `files` — всё, что лежит внутри папки или архива: путь → байты. `bundle`
 * нужен затем, что счётчик заметок обязан совпадать с тем, сколько заметок
 * реально получится: у Notion одна база данных превращается в заметку, у Bear
 * пакет `.textbundle` — тоже в одну. Считать по именам файлов значило бы
 * обещать на шаге 2 одно число, а перенести другое.
 */
export function scanImport(files: Map<string, Uint8Array>, bundle: ImportBundle): ImportScan {
  const paths = [...files.keys()].map((name) => name.replace(/\\/g, '/'));
  const source = detectImportSource(paths);
  let bytes = 0;
  for (const data of files.values()) bytes += data.byteLength;

  const scan: ImportScan = {
    source,
    documents: bundle.notes.length,
    attachments: bundle.assets.length,
    groups: groupsOf(source, paths, bundle),
    bytes,
    losses: lossesOf(source, paths, files),
    folder: defaultImportFolder(source),
  };
  return scan;
}

/** Третья плитка. У каждого источника она про своё — так и в спецификации. */
function groupsOf(source: ImportSource, paths: string[], bundle: ImportBundle): number {
  if (source === 'notion') return paths.filter((path) => /\.csv$/i.test(path)).length;
  if (source === 'evernote') return paths.filter((path) => /\.enex$/i.test(path)).length;
  return bundle.folders;
}

function lossesOf(
  source: ImportSource,
  paths: string[],
  files: Map<string, Uint8Array>,
): ImportLoss[] {
  const losses: ImportLoss[] = [];

  if (source === 'notion') {
    const databases = paths.filter((path) => /\.csv$/i.test(path)).length;
    if (databases > 0) losses.push({ kind: 'notion-databases', count: databases });
    /* Вложенная страница у Notion — это папка с хвостом-идентификатором. */
    const nested = paths.some((path) => /[ -][0-9a-f]{32}\//i.test(path));
    if (nested) losses.push({ kind: 'notion-subpages' });
    /* Всё, что не markdown, не csv и не знакомое вложение, переносится как
       есть: встроенные виджеты Notion выгружаются html-файлами. */
    const asIs = paths.filter(
      (path) =>
        !/\.(md|markdown|txt|csv)$/i.test(path) && !KNOWN_ASSET.test(path) && !path.endsWith('/'),
    ).length;
    if (asIs > 0) losses.push({ kind: 'kept-as-is', count: asIs });
  }

  if (source === 'evernote') {
    /* Читаем только `.enex`: это разметка выгрузки, а не содержимое вложений. */
    let tables = false;
    let handwriting = 0;
    for (const [path, data] of files) {
      if (!/\.enex$/i.test(path)) continue;
      const text = decode(data);
      if (/<table[\s>]/i.test(text)) tables = true;
      /* Рукописные заметки Evernote — вложения особого типа. */
      handwriting += text.match(/application\/vnd\.evernote\.ink/gi)?.length ?? 0;
    }
    if (tables) losses.push({ kind: 'evernote-tables' });
    if (handwriting > 0) losses.push({ kind: 'evernote-handwriting', count: handwriting });
  }

  return losses;
}
