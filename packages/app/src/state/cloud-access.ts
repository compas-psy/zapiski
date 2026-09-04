/**
 * SEC-001 — состояние доступа к Облаку Записок и fail-closed фабрика.
 *
 * ── Зачем отдельный модуль, а не флаг внутри `createCloudBackend` ─────────
 *
 * Инвариант, который здесь держится, один и он критический:
 *
 *   бэкенд Облака Записок НЕ СУЩЕСТВУЕТ без ключа шифрования.
 *
 * Не «создаётся и потом проверяет», не «создаётся с `sync?: undefined` и
 * работает как раньше» — а не создаётся вовсе. Поэтому тип
 * `CloudAccess` — единственный вход в фабрику: чтобы получить бэкенд,
 * вызывающий обязан СНАЧАЛА разрешить состояние, и только состояние
 * `encrypted_ready` несёт в себе `SyncCrypto`. Забыть проверку нельзя —
 * её нечем обойти, кроме как подделав значение, которое умеет собирать
 * только `resolveCloudAccess`.
 *
 * До этой правки `sync` был необязательным параметром, и «забыли передать»
 * означало тихую отправку открытого текста. Необязательность осталась в
 * ядре — там она нужна тестам и совместимости с уже лежащими в облаке
 * открытыми объектами, — но прикладной путь CMPAS Cloud её больше не
 * использует.
 *
 * ── Состояния ────────────────────────────────────────────────────────────
 *
 *   `cloud_disabled`     — облако выключено: флагом или платформой;
 *   `needs_onboarding`   — у аккаунта ещё нет ключа, надо создать и показать
 *                          код восстановления;
 *   `needs_recovery`     — ключ у аккаунта ЕСТЬ, а на этом устройстве его
 *                          нет: нужен код восстановления. Именно сюда
 *                          обязан приводить отсутствующий локальный ключ —
 *                          НЕ к созданию открытого бэкенда;
 *   `encrypted_ready`    — ключ есть, шифрование работает;
 *   `migration_required` — у аккаунта остались незашифрованные объекты
 *                          прошлых версий (см. `docs/dev/security/
 *                          SEC-001-legacy-check.sql`).
 */
import {
  CLOUD_SYNC_ENABLED,
  SyncKeyOnboarding,
  ZapiskiCloudBackend,
  type PlatformCapabilities,
  type SyncCrypto,
} from '@zapiski/core';

import { createCloudBackend, originOf, type CloudBackendOptions } from './cloud.js';

export type CloudAccess =
  | { status: 'cloud_disabled'; reason: 'flag' | 'platform' }
  | { status: 'needs_onboarding' }
  | { status: 'needs_recovery' }
  | { status: 'encrypted_ready'; sync: SyncCrypto }
  | { status: 'migration_required'; sync: SyncCrypto };

/**
 * Есть ли на этой платформе защищённое хранилище для ключа синка.
 *
 * Windows (DPAPI), macOS (Keychain), Android (Keystore) — есть, и оно того
 * же класса, что уже принят для пароля vault'а. Web — НЕТ: браузер не даёт
 * аппаратного эквивалента, а `IndexedDB` читается любым JS того же origin
 * (design §3.1, признано прямо). Держать там извлекаемый SMK — не
 * «немного слабее», а другой уровень защиты, и делать вид, что это одно и
 * то же, нельзя.
 *
 * Поэтому Облако в вебе пока выключено ЧЕСТНО, отдельным состоянием с
 * причиной `platform`, а не тихо. Локальные ЗАПИСКИ в вебе работают как
 * работали — блокируется только облако. Windows/macOS/Android этим не
 * задерживаются.
 */
export function platformSupportsSecureKeyStorage(platform: PlatformCapabilities): boolean {
  if (platform.kind === 'web') return false;
  return platform.biometrics !== null;
}

export interface ResolveCloudAccessOptions {
  platform: PlatformCapabilities;
  cloudBaseUrl: string;
  /** Уже авторизованный `fetch` — токен ставит вызывающий. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Есть ли у аккаунта незашифрованные объекты прошлых версий. */
  hasLegacyPlaintext?: () => Promise<boolean>;
}

/** Онбординг-клиент для этого устройства. Вынесен, чтобы тесты его подменяли. */
export function createOnboarding(options: ResolveCloudAccessOptions): SyncKeyOnboarding {
  return new SyncKeyOnboarding({
    baseUrl: originOf(options.cloudBaseUrl),
    fetch: options.fetch as never,
    biometrics: options.platform.biometrics,
  });
}

/**
 * Где мы находимся — единственный законный способ узнать.
 *
 * Сеть недоступна → `needs_recovery`, а НЕ «поехали без шифрования»:
 * неизвестность обязана трактоваться в пользу закрытого состояния.
 */
export async function resolveCloudAccess(
  options: ResolveCloudAccessOptions,
  onboarding: SyncKeyOnboarding = createOnboarding(options),
): Promise<CloudAccess> {
  if (!CLOUD_SYNC_ENABLED) return { status: 'cloud_disabled', reason: 'flag' };
  if (!platformSupportsSecureKeyStorage(options.platform)) {
    return { status: 'cloud_disabled', reason: 'platform' };
  }

  const state = await onboarding.state().catch(() => null);
  /* Неизвестность — в пользу закрытого состояния. `unknown` (сервер не
     ответил) НЕ означает «ключа нет»: предложить создать ключ аккаунту,
     у которого он уже есть, — прямой путь к потере доступа к своим же
     зашифрованным заметкам. */
  if (state === null || state.status === 'unknown') return { status: 'needs_recovery' };
  if (state.status === 'none') return { status: 'needs_onboarding' };
  if (state.status === 'needs-code') return { status: 'needs_recovery' };

  if (options.hasLegacyPlaintext !== undefined) {
    const legacy = await options.hasLegacyPlaintext().catch(() => false);
    if (legacy) return { status: 'migration_required', sync: state.crypto };
  }
  return { status: 'encrypted_ready', sync: state.crypto };
}

/**
 * Бэкенд Облака Записок — ТОЛЬКО из состояния, которое несёт ключ.
 *
 * `null` во всех остальных случаях, и это не «мягкий отказ»: вызывающий
 * обязан показать человеку состояние (введите код / включите облако /
 * недоступно на этой платформе), а не молча синхронизировать что-то ещё.
 */
export function createEncryptedCloudBackend(
  access: CloudAccess,
  options: CloudBackendOptions,
): ZapiskiCloudBackend | null {
  if (access.status !== 'encrypted_ready' && access.status !== 'migration_required') return null;
  return createCloudBackend({ ...options, sync: access.sync });
}
