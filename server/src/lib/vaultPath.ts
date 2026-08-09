import type { VaultPath } from '../protocol.ts';
import { shortHash } from './crypto.ts';

/**
 * Путь внутри vault'а — это пользовательские данные (в нём заголовок заметки).
 * Поэтому: в базе он лежит, в ответах API он есть, а в логах — никогда,
 * только `shortHash` (ТЗ §6, приватность).
 */

/** Максимальная длина пути, чтобы не раздувать индекс и заголовки. */
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

export type PathValidation = { ok: true; path: VaultPath } | { ok: false; reason: string };

/**
 * Нормализует и валидирует путь: прямые слэши, без ведущего слэша,
 * без `.`/`..`, без управляющих символов и NUL, без пустых сегментов.
 */
export function normalizeVaultPath(raw: string): PathValidation {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty' };

  let value = raw;
  // Клиент может прислать percent-encoded путь в URL — декодируем один раз.
  if (value.includes('%')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return { ok: false, reason: 'bad_encoding' };
    }
  }

  value = value.replace(/\\/g, '/');
  while (value.startsWith('/')) value = value.slice(1);

  if (value.length === 0) return { ok: false, reason: 'empty' };
  if (value.length > MAX_PATH_LENGTH) return { ok: false, reason: 'too_long' };
  // NUL и управляющие символы.
  if (/[\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: 'control_char' };

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: 'empty_segment' };
    if (segment === '.' || segment === '..') return { ok: false, reason: 'traversal' };
    if (segment.length > MAX_SEGMENT_LENGTH) return { ok: false, reason: 'segment_too_long' };
    // Windows-совместимость: имена вида `CON`, хвостовые точки/пробелы.
    if (/[\s.]$/.test(segment)) return { ok: false, reason: 'trailing_space_or_dot' };
  }

  return { ok: true, path: segments.join('/') };
}

/**
 * Значение для логов: путь заменяется коротким хешем.
 * `logPath('Проекты/Идея.md')` → `path#3f2a1b8c9d0e`
 */
export function logPath(path: string): string {
  return `path#${shortHash(path)}`;
}

/** Идентификатор заметки: непрозрачная строка от клиента, ограничиваем формат. */
const NOTE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isValidNoteId(value: string): boolean {
  return NOTE_ID_RE.test(value);
}

/** Идентификатор устройства, который присылает клиент. */
const DEVICE_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

export function isValidDeviceKey(value: string): boolean {
  return DEVICE_KEY_RE.test(value);
}
