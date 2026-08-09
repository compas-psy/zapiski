/**
 * Импорт папки `.md` — в первую очередь Obsidian-vault (ТЗ §5.3, BEHAVIOR §9:
 * «Obsidian-vault импортируется как есть, включая `attachments` и frontmatter»).
 *
 * Ничего не конвертируем: тела заметок переносятся байт-в-байт, wiki-ссылки
 * остаются рабочими, потому что структура папок сохраняется.
 */
import { decode, emptyBundle, isMarkdownFile, unzip, type ImportBundle } from './types.js';
import { normalizePath } from '../util/path.js';

/** Служебные каталоги чужих приложений — их переносить не нужно. */
const SKIP = [/(^|\/)\.obsidian\//i, /(^|\/)\.trash\//i, /(^|\/)\.zapiski\//i, /(^|\/)__MACOSX\//, /(^|\/)\.DS_Store$/];

export interface FolderImportOptions {
  /** Убрать общий верхний каталог архива (`Мой vault/…`). */
  stripRoot?: boolean;
}

export function importFolder(files: Map<string, Uint8Array>, options: FolderImportOptions = {}): ImportBundle {
  const bundle = emptyBundle();
  const entries = [...files].filter(([name]) => !SKIP.some((re) => re.test(name)));
  const prefix = options.stripRoot === false ? '' : commonPrefix(entries.map(([name]) => name));
  const folders = new Set<string>();

  for (const [rawName, data] of entries) {
    const name = normalizePath(rawName.slice(prefix.length));
    if (name === '') continue;
    const slash = name.lastIndexOf('/');
    if (slash > 0) folders.add(name.slice(0, slash));
    if (isMarkdownFile(name)) {
      bundle.notes.push({ relativePath: name.replace(/\.(markdown|txt)$/i, '.md'), body: decode(data) });
    } else {
      bundle.assets.push({ relativePath: name, data });
    }
  }
  bundle.folders = folders.size;
  return bundle;
}

/** Тот же импорт, но вход — zip-архив папки. */
export function importFolderZip(zip: Uint8Array, options: FolderImportOptions = {}): ImportBundle {
  return importFolder(unzip(zip), options);
}

function commonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  const first = names[0] as string;
  const slash = first.indexOf('/');
  if (slash === -1) return '';
  const candidate = first.slice(0, slash + 1);
  return names.every((name) => name.startsWith(candidate)) ? candidate : '';
}
