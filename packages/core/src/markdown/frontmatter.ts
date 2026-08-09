/**
 * YAML frontmatter — ОПЦИОНАЛЕН (ТЗ §3.2): приложение его сохраняет, но не
 * требует. Полноценный YAML нам не нужен и вреден: цель — не потерять ни одной
 * строки чужого Obsidian-vault'а, поэтому блок хранится как упорядоченный
 * список записей с исходными строками, а меняются только служебные поля
 * (id / created / updated / pinned / archived / tags).
 */

export type FrontmatterValue = string | number | boolean | null | string[];

interface FrontmatterEntry {
  key: string;
  /** Исходные строки записи, включая продолжения блочного списка. */
  raw: string[];
  value: FrontmatterValue;
}

export class Frontmatter {
  private entries: FrontmatterEntry[] = [];

  static parse(lines: string[]): Frontmatter {
    const fm = new Frontmatter();
    let current: FrontmatterEntry | null = null;
    const listItems: string[] = [];
    const flush = (): void => {
      if (!current) return;
      if (listItems.length > 0) current.value = [...listItems];
      fm.entries.push(current);
      listItems.length = 0;
      current = null;
    };
    for (const line of lines) {
      const listMatch = /^\s*-\s+(.*)$/.exec(line);
      if (listMatch && current) {
        listItems.push(unquote(listMatch[1] as string));
        current.raw.push(line);
        continue;
      }
      const kv = /^([A-Za-zА-Яа-я0-9_.\-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) {
        flush();
        current = { key: kv[1] as string, raw: [line], value: parseScalar(kv[2] as string) };
        continue;
      }
      // Строка, которую мы не поняли (вложенный маппинг, комментарий) —
      // прикрепляем к текущей записи, чтобы не потерять при перезаписи.
      if (current) current.raw.push(line);
      else fm.entries.push({ key: '', raw: [line], value: null });
    }
    flush();
    return fm;
  }

  get keys(): string[] {
    return this.entries.filter((e) => e.key !== '').map((e) => e.key);
  }

  has(key: string): boolean {
    return this.entries.some((e) => e.key === key);
  }

  get(key: string): FrontmatterValue | undefined {
    return this.entries.find((e) => e.key === key)?.value;
  }

  getString(key: string): string | undefined {
    const value = this.get(key);
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  getNumber(key: string): number | undefined {
    const value = this.get(key);
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber) && value.trim() !== '') return asNumber;
      const asDate = Date.parse(value);
      if (Number.isFinite(asDate)) return asDate;
    }
    return undefined;
  }

  getBoolean(key: string): boolean | undefined {
    const value = this.get(key);
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  getList(key: string): string[] {
    const value = this.get(key);
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return [];
  }

  set(key: string, value: FrontmatterValue): void {
    const raw = renderEntry(key, value);
    const existing = this.entries.find((e) => e.key === key);
    if (existing) {
      existing.raw = raw;
      existing.value = value;
      return;
    }
    this.entries.push({ key, raw, value });
  }

  remove(key: string): void {
    this.entries = this.entries.filter((e) => e.key !== key);
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  toLines(): string[] {
    return this.entries.flatMap((e) => e.raw);
  }
}

function parseScalar(raw: string): FrontmatterValue {
  const text = raw.trim();
  if (text === '') return null;
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => unquote(part.trim()));
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return unquote(text);
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1);
  }
  return text;
}

function needsQuotes(text: string): boolean {
  return /^[\s]|[\s]$|^[[{&*#?|>%@`!-]|:\s|,/.test(text) || text === '';
}

function renderScalar(value: Exclude<FrontmatterValue, string[]>): string {
  if (value === null) return '';
  if (typeof value === 'string') return needsQuotes(value) ? JSON.stringify(value) : value;
  return String(value);
}

function renderEntry(key: string, value: FrontmatterValue): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${key}: []`];
    return [`${key}:`, ...value.map((item) => `  - ${needsQuotes(item) ? JSON.stringify(item) : item}`)];
  }
  return [`${key}: ${renderScalar(value)}`];
}

export interface SplitDocument {
  frontmatter: Frontmatter | null;
  /** Тело без frontmatter-блока. */
  body: string;
}

const FM_OPEN = /^---\s*$/;

/** Отделяет frontmatter от тела. Отсутствие блока — норма, а не ошибка. */
export function splitFrontmatter(text: string): SplitDocument {
  // Учитываем BOM и CRLF: чужие vault'ы приходят с чем угодно.
  const clean = text.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/);
  if (lines.length === 0 || !FM_OPEN.test(lines[0] ?? '')) return { frontmatter: null, body: clean };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FM_OPEN.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: null, body: clean };
  const fm = Frontmatter.parse(lines.slice(1, end));
  return { frontmatter: fm, body: lines.slice(end + 1).join('\n').replace(/^\n/, '') };
}

/** Собирает файл обратно. Пустой frontmatter не пишется вовсе. */
export function joinFrontmatter(frontmatter: Frontmatter | null, body: string): string {
  if (!frontmatter || frontmatter.isEmpty) return body;
  return ['---', ...frontmatter.toLines(), '---', body].join('\n');
}
