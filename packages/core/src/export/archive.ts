/**
 * Экспорт нескольких заметок: zip с сохранением структуры папок и
 * `attachments` (BEHAVIOR §9). Формат — тот же `.md`, что лежит на диске:
 * «file over app», экспорт не должен ничего конвертировать.
 */
import { zipSync } from 'fflate';
import type { Note, VaultPath } from '../contract.js';
import { parseNote } from '../markdown/parse.js';
import { normalizePath } from '../util/path.js';
import { utf8 } from '../util/bytes.js';
import type { Vault } from '../vault/vault.js';
import { renderPrintableHtml } from './html.js';
import { exportDocx } from './docx.js';

export type ExportFormat = 'md' | 'html' | 'docx';

export interface ArchiveOptions {
  /** Включать ли вложения, на которые ссылаются заметки. По умолчанию да. */
  attachments?: boolean;
  format?: ExportFormat;
}

/** Одна заметка в выбранном формате. */
export function exportNote(note: Note, format: ExportFormat): { name: string; data: Uint8Array } {
  switch (format) {
    case 'html':
      return { name: `${note.title}.html`, data: utf8(renderPrintableHtml(note)) };
    case 'docx':
      return { name: `${note.title}.docx`, data: exportDocx(note) };
    default:
      return { name: `${note.title}.md`, data: utf8(note.body) };
  }
}

/** Несколько заметок — zip со структурой папок vault'а. */
export async function exportArchive(
  vault: Vault,
  paths: VaultPath[],
  options: ArchiveOptions = {},
): Promise<Uint8Array> {
  const format = options.format ?? 'md';
  const withAttachments = options.attachments ?? true;
  const files: Record<string, Uint8Array> = {};
  const attachments = new Set<VaultPath>();

  for (const path of paths) {
    const note = await vault.read(normalizePath(path));
    if (!note || note.encrypted) continue; // зашифрованная экспортируется только после разблокировки
    const exported = exportNote(note, format);
    const target = path.replace(/\.md$/, '').concat(exported.name.slice(exported.name.lastIndexOf('.')));
    files[target] = exported.data;
    if (!withAttachments) continue;
    for (const link of parseNote(note.body).links) {
      const url = (link.url.split('#')[0] as string).trim();
      if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
      attachments.add(normalizePath(url));
    }
  }

  for (const attachment of attachments) {
    const data = await vault.storage.read(attachment);
    if (data) files[attachment] = data;
  }

  return zipSync(files, { level: 6 });
}
