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
}

export interface ImportReport {
  imported: number;
  skipped: number;
  attachments: number;
  paths: VaultPath[];
  warnings: string[];
  /** Текст для мастера — из реестра BEHAVIOR §11. */
  message: string;
}

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
