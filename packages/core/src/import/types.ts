/**
 * Импорт (ТЗ §5.3, BEHAVIOR §9). Общая модель для всех источников: импортёр
 * превращает вход в `ImportBundle`, а запись в vault — общая для всех, потому
 * что общее правило одно и оно жёсткое: **импорт никогда не перезаписывает
 * существующие заметки**, коллизии разрешаются суффиксом.
 */
import type { VaultPath } from '../contract.js';
import { unzipSync } from 'fflate';

export interface ImportNote {
  /** Путь относительно целевой папки, включая `.md`. */
  relativePath: string;
  body: string;
}

export interface ImportAsset {
  relativePath: string;
  data: Uint8Array;
}

export interface ImportBundle {
  notes: ImportNote[];
  assets: ImportAsset[];
  /** Что не удалось перенести один в один — попадает в отчёт мастера. */
  warnings: string[];
  folders: number;
  /**
   * Сколько ссылок переписал сам импортёр, приводя источник к нашим правилам:
   * `assets/…` → `attachments/…` у Bear, срезанные хвосты-идентификаторы у
   * Notion. Отчёт складывает это с переписанными из-за коллизий имён.
   */
  linksRewritten?: number;
}

/**
 * Почему файл пропустили. Набор ЗАКРЫТЫЙ — спецификация импорта §2 перечисляет
 * причины таблицей, и текст к каждой берётся из словаря приложения, а не
 * собирается здесь. Свободной строки в этом списке нет намеренно: «что-то не
 * получилось» человеку не говорит ничего.
 */
export type ImportSkipReason = 'unreadable' | 'unsupported' | 'too-large' | 'no-access';

export interface ImportSkip {
  /** Путь В ИСХОДНИКЕ: список пропущенного ведёт к файлам человека. */
  path: string;
  reason: ImportSkipReason;
  /** Для `unsupported` — имя формата, которое подставляется в текст. */
  format?: string;
}

export interface ImportReport {
  imported: number;
  skipped: number;
  attachments: number;
  /**
   * Сколько ссылок переписано.
   *
   * Считаются два случая: `[[wiki-ссылки]]`, поехавшие за переименованием из-за
   * коллизии имён, и относительные пути вложений, которые импортёр привёл к
   * нашей конвенции. Отчёт показывает это строкой «Ссылок переписано» — и
   * показывать её, не считая, было бы обещанием без содержания.
   */
  linksRewritten: number;
  /** Сколько имён получили суффикс из-за совпадения с существующими (§4.1). */
  suffixed: number;
  /** Что пропустили и почему — список для экрана «Что пропустили». */
  skips: ImportSkip[];
  paths: VaultPath[];
  warnings: string[];
  /** Текст для мастера — из реестра BEHAVIOR §11. */
  message: string;
}

/**
 * Предел одного вложения — 200 МБ (§4.6).
 *
 * Сверх предела вложение пропускается с причиной, а заметка переносится без
 * него: терять текст из-за приложенного видео на полтора гигабайта неправильно.
 */
export const IMPORT_ASSET_LIMIT = 200 * 1024 * 1024;

export function emptyBundle(): ImportBundle {
  return { notes: [], assets: [], warnings: [], folders: 0 };
}

/** Распаковка zip: Bear, Notion и папки, отданные как архив. */
export function unzip(data: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const files = unzipSync(data);
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    out.set(name.replace(/\\/g, '/'), bytes);
  }
  return out;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

export function decode(data: Uint8Array): string {
  return decoder.decode(data).replace(/^﻿/, '');
}

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name);
}
