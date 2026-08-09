/**
 * Имя файла = заголовок (BEHAVIOR §2.2). Запрещённые в ФС символы
 * `/ \ : * ? " < > |` заменяются на `-`, коллизия имён — суффикс ` 2`, ` 3`.
 */
import type { VaultPath } from '../contract.js';
import { joinPath } from '../util/path.js';

/** Символы, запрещённые в именах файлов (BEHAVIOR §2.2). */
const FORBIDDEN = /[/\\:*?"<>|]/g;
/** Управляющие символы — в имя файла им тоже нельзя. */
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Зарезервированные имена Windows — на них ломается desktop-сборка. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_STEM = 120;

/** Заголовок → безопасное имя файла без расширения. */
export function safeFileName(title: string): string {
  let name = title
    .replace(FORBIDDEN, '-')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Точки в конце имени Windows молча срезает — срезаем сами и предсказуемо.
    .replace(/[.\s]+$/, '')
    .replace(/^[.\s]+/, '');
  if (name.length > MAX_STEM) name = name.slice(0, MAX_STEM).trimEnd();
  if (name === '') name = 'Без названия';
  if (RESERVED.test(name)) name = `${name} заметка`;
  return name;
}

/**
 * Разрешение коллизии: `Идея` → `Идея 2` → `Идея 3` (BEHAVIOR §2.2).
 * `taken` возвращает true, если путь уже занят; `self` (текущий путь заметки)
 * коллизией не считается — переименование в самого себя не должно плодить « 2».
 */
export function uniqueNotePath(
  folder: VaultPath,
  stem: string,
  extension: string,
  taken: (path: VaultPath) => boolean,
  self?: VaultPath,
): VaultPath {
  const base = safeFileName(stem);
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = joinPath(folder, `${base}${n === 1 ? '' : ` ${n}`}${extension}`);
    if (candidate === self || !taken(candidate)) return candidate;
  }
  /* c8 ignore next 2 -- недостижимо: 10 000 одноимённых заметок в одной папке */
  throw new Error('Не удалось подобрать имя файла');
}

/** Имя вложения: `attachments/ГГГГ-ММ-ДД_хеш.ext` (ТЗ §3.2). */
export function attachmentName(date: string, hash: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : extension === '' ? '' : `.${extension}`;
  return `${date}_${hash}${ext.toLowerCase()}`;
}
