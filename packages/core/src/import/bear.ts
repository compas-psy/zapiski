/**
 * Импорт Bear: `.bear2bk` — zip из textbundle-пакетов (ТЗ §5.3).
 *
 * Структура: `<Заметка>.textbundle/text.md` + `assets/` + `info.json`.
 * Bear пишет ссылки на вложения как `assets/…`; переписываем их в конвенцию
 * ЗАПИСОК `attachments/…` — «единая конвенция на всех платформах» (ТЗ §3.2).
 */
import { decode, emptyBundle, unzip, type ImportBundle } from './types.js';
import { ATTACHMENTS_DIR } from '../util/path.js';
import { extractTitle } from '../markdown/parse.js';

export function importBear(zip: Uint8Array): ImportBundle {
  return importBearFiles(unzip(zip));
}

export function importBearFiles(files: Map<string, Uint8Array>): ImportBundle {
  const bundle = emptyBundle();
  const bundles = new Map<string, { text?: string; assets: Array<{ name: string; data: Uint8Array }> }>();

  for (const [name, data] of files) {
    if (name.includes('__MACOSX/') || name.endsWith('.DS_Store')) continue;
    const match = /^(.*?\.textbundle)\/(.*)$/.exec(name);
    if (!match) continue;
    const key = match[1] as string;
    const rest = match[2] as string;
    let entry = bundles.get(key);
    if (!entry) {
      entry = { assets: [] };
      bundles.set(key, entry);
    }
    if (/^text\.(md|markdown)$/i.test(rest)) entry.text = decode(data);
    else if (/^assets\//i.test(rest)) entry.assets.push({ name: rest.slice('assets/'.length), data });
  }

  if (bundles.size === 0) {
    bundle.warnings.push('В архиве не найдено ни одного пакета .textbundle');
    return bundle;
  }

  /* Сколько ссылок на вложения привели к нашей конвенции — в отчёт. */
  let rewritten = 0;

  for (const [key, entry] of bundles) {
    if (entry.text === undefined) {
      bundle.warnings.push(`${key}: нет text.md`);
      continue;
    }
    let body = entry.text;
    for (const asset of entry.assets) {
      const target = `${ATTACHMENTS_DIR}/${asset.name}`;
      bundle.assets.push({ relativePath: target, data: asset.data });
      /* Считаем подмены: отчёт обещает строку «Ссылок переписано», и число в
         ней обязано быть настоящим. */
      const pieces = body.split(`assets/${asset.name}`);
      rewritten += pieces.length - 1;
      body = pieces.join(target);
    }
    const stem = key.replace(/\.textbundle$/i, '').split('/').pop() as string;
    const title = extractTitle(body);
    const fileName = title !== '' ? title : stem;
    bundle.notes.push({ relativePath: `${sanitize(fileName)}.md`, body });
  }
  bundle.linksRewritten = rewritten;
  return bundle;
}

function sanitize(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '-').trim();
}
