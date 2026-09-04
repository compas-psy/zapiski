/**
 * SEC-001 §7 — зашифрованный манифест vault'а.
 *
 * ── Зачем он обязателен, а не «фаза 2» ───────────────────────────────────
 *
 * После анонимизации путей сервер хранит объекты под непрозрачными адресами
 * `HMAC(секрет адресов, путь)`. Устройство, которое САМО положило заметку,
 * знает соответствие и без манифеста — токен детерминирован. А вот второе
 * устройство, пришедшее на чистую установку, видит в `list()` только
 * шестнадцатеричные токены и не может превратить их обратно в
 * `Личное/Дневник.md`: HMAC необратим, в этом и был смысл.
 *
 * Без манифеста облако теряет главное — «включил на втором устройстве и
 * увидел свои заметки». Поэтому манифест — часть MVP, а не улучшение.
 *
 * ── Что внутри ───────────────────────────────────────────────────────────
 *
 * Минимум, достаточный для восстановления структуры: список реальных путей.
 * Токены в манифесте НЕ хранятся — они выводятся из путей тем же ключом,
 * так что дублировать их значило бы хранить две копии одного факта и
 * получить возможность их рассинхронизации.
 *
 * Манифест шифруется `K_manifest` (`sealManifest`) и лежит на сервере как
 * обычный блоб по своему собственному фиксированному адресу. Сервер видит
 * непрозрачные байты — как и для любой заметки.
 *
 * ── Согласованность без распределённой системы ───────────────────────────
 *
 * Манифест может отстать: приложение упало между записью заметки и записью
 * манифеста. Это не потеря данных — заметка на сервере есть, а на новом
 * устройстве она просто не появится до следующего обновления манифеста.
 * Восстановление тоже без отдельной машинерии: манифест собирается из
 * ЛОКАЛЬНОГО списка путей (источник истины — vault, invariant #1), поэтому
 * очередной синк с любого устройства, знающего свои пути, чинит его целиком.
 */
import type { VaultPath } from '../contract.js';
import { fromUtf8, utf8 } from '../util/bytes.js';
import type { SyncCrypto } from './sync-crypto.js';

/**
 * Адрес манифеста на сервере. Фиксированный и не выводится из ключа: его
 * должно быть видно ДО того, как что-либо расшифровано, иначе новое
 * устройство не знало бы, что запрашивать.
 */
export const MANIFEST_ADDRESS = '.zapiski-manifest';

/** Версия — чтобы менять раскладку, не гадая, что лежит в облаке. */
export const MANIFEST_VERSION = 1;

export interface VaultManifest {
  version: number;
  /** Реальные пути заметок. Токены выводятся из них, а не хранятся. */
  paths: VaultPath[];
  /** Когда собран — для диагностики, на решения не влияет. */
  updatedAt: number;
}

export function emptyManifest(now = Date.now()): VaultManifest {
  return { version: MANIFEST_VERSION, paths: [], updatedAt: now };
}

/**
 * Собрать манифест из локальных путей.
 *
 * Пути сортируются: одинаковый vault обязан давать одинаковые байты, иначе
 * манифест перезаписывался бы на каждом синке из-за порядка обхода и
 * бессмысленно гонял трафик.
 */
export function buildManifest(paths: readonly VaultPath[], now = Date.now()): VaultManifest {
  return {
    version: MANIFEST_VERSION,
    paths: [...new Set(paths)].sort(),
    updatedAt: now,
  };
}

export async function sealManifest(crypto: SyncCrypto, manifest: VaultManifest): Promise<Uint8Array> {
  return crypto.sealManifest(utf8(JSON.stringify(manifest)));
}

/**
 * `null` — не наш манифест, чужой ключ или порча. Как и везде в синке,
 * отказ расшифровки не бросает: вызывающий обходится без манифеста, а не
 * падает (BEHAVIOR §5.2).
 */
export async function openManifest(
  crypto: SyncCrypto,
  envelope: Uint8Array,
): Promise<VaultManifest | null> {
  const opened = await crypto.openManifest(envelope);
  if (opened === null) return null;
  try {
    const parsed = JSON.parse(fromUtf8(opened)) as VaultManifest;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (!Array.isArray(parsed.paths)) return null;
    return {
      version: Number(parsed.version ?? MANIFEST_VERSION),
      paths: parsed.paths.filter((p): p is VaultPath => typeof p === 'string'),
      updatedAt: Number(parsed.updatedAt ?? 0),
    };
  } catch {
    return null;
  }
}
