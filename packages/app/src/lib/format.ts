/**
 * Форматирование дат, размеров и метастрок.
 * Группировка списка по месяцам — BEHAVIOR §1.2.
 */
import type { Strings } from '../i18n/index.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Ключ секции списка: «АВГУСТ» для текущего года, «АВГУСТ 2025» для прошлых
 * (BEHAVIOR §1.2 — дословно этот пример).
 */
export function monthSection(timestamp: number, strings: Strings, now = Date.now()): string {
  const date = new Date(timestamp);
  const month = strings.months[date.getMonth()] ?? '';
  const year = date.getFullYear();
  return year === new Date(now).getFullYear() ? month : `${month} ${year}`;
}

/** Стабильный ключ месяца — по нему группируются строки до сортировки. */
export function monthKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
}

/** «только что» / «5 минут назад» / «вчера» / дата — для статус-строки и метастроки. */
export function relativeTime(timestamp: number, strings: Strings, now = Date.now()): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < MINUTE) return strings.relative.justNow;
  if (delta < HOUR) return strings.relative.minutesAgo(Math.floor(delta / MINUTE));
  if (delta < DAY) return strings.relative.hoursAgo(Math.floor(delta / HOUR));
  if (delta < 2 * DAY) return strings.relative.yesterday;
  return noteDate(timestamp, strings, now);
}

/**
 * Дата словами: «5 авг» в этом году, «5 августа 2025» в прошлые
 * (ITERATION-1 §2). Здесь, а не `shortDate`, потому что это строка списка и
 * статуса — её читают глазами. Цифровой формат остаётся в моно-метастроках,
 * где важна одинаковая ширина.
 */
export function noteDate(timestamp: number, strings: Strings, now = Date.now()): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  return year === new Date(now).getFullYear()
    ? strings.dayMonth(date.getDate(), date.getMonth())
    : strings.dayMonthYear(date.getDate(), date.getMonth(), year);
}

/** Дата в моно-метастроке: 09.08.2026. */
export function shortDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** Время в статусе синка: 14:32. */
export function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Человекочитаемый объём: 96 МБ. */
export function formatBytes(bytes: number, strings: Strings): string {
  if (bytes < 1024) return strings.units.bytes(bytes);
  if (bytes < 1024 ** 2) return strings.units.kilobytes(Math.round(bytes / 1024));
  if (bytes < 1024 ** 3) return strings.units.megabytes(Math.round(bytes / 1024 ** 2));
  return strings.units.gigabytes(Math.round((bytes / 1024 ** 3) * 10) / 10);
}

/** Время чтения: 200 слов в минуту, минимум минута. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 200));
}
