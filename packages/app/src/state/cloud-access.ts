/**
 * Доступ к Облаку Записок: где мы находимся и можно ли создавать бэкенд.
 *
 * ── Что изменилось и почему ──────────────────────────────────────────────
 *
 * Раньше здесь держался инвариант «бэкенд Облака НЕ СУЩЕСТВУЕТ без ключа
 * шифрования». Решение владельца — убрать сквозное шифрование из MVP и
 * вернуть его позже через внешнюю ключницу — этот инвариант снимает: ключа
 * на пути пользователя больше нет, а значит требовать его от фабрики
 * бессмысленно.
 *
 * Снятие инварианта НЕ означает «стало всё равно». Оно означает, что
 * граница безопасности переехала, и переехала целиком:
 *
 *   • содержимое шифруется на диске сервера (`services/blobStore.ts`) —
 *     закрыт доступ к файлам в обход приложения;
 *   • заметки одного человека от другого отделяет теперь ТОЛЬКО серверная
 *     авторизация, и она покрыта сторожами IDOR по всем методам
 *     (`server/test/security.perimeter.test.ts`);
 *   • сервер содержимое прочитать МОЖЕТ. Это осознанная плата, и интерфейс
 *     обязан говорить о ней честно, а не повторять прежнее обещание.
 *
 * Модуль оставлен на месте, а не удалён: он же будет точкой возврата
 * шифрования, когда ключ начнёт приходить из ключницы. Криптография в ядре
 * (`SyncCrypto`, `SyncKeyOnboarding`) тоже осталась и покрыта тестами — она
 * нужна прямо сейчас для перевода тех, кто успел включить шифрование.
 *
 * ── Состояния ────────────────────────────────────────────────────────────
 *
 *   `cloud_disabled`   — облако выключено флагом целиком;
 *   `unavailable`      — состояние облака выяснить не удалось (нет сети).
 *                        Не «поехали как есть»: у аккаунта МОГ остаться
 *                        ключ, и запись открытого текста поверх шифротекста
 *                        всё равно была бы отбита сервером;
 *   `ready`            — обычный путь: синхронизация без шифрования;
 *   `unlock_required`  — у аккаунта остался ключ прошлой схемы, и он есть на
 *                        ЭТОМ устройстве: перевести и продолжить;
 *   `locked_elsewhere` — ключ у аккаунта есть, а на этом устройстве его нет.
 *                        Единственное честное действие — сказать человеку
 *                        открыть облако на том устройстве, где оно уже
 *                        работало. Ничего разрушительного.
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
  | { status: 'cloud_disabled'; reason: 'flag' }
  | { status: 'unavailable' }
  | { status: 'ready' }
  | { status: 'unlock_required'; sync: SyncCrypto }
  | { status: 'locked_elsewhere' };

/**
 * Есть ли на этой платформе защищённое хранилище для ключа.
 *
 * Windows (DPAPI), macOS (Keychain), Android (Keystore) — есть. Web — НЕТ:
 * браузер не даёт аппаратного эквивалента, а `IndexedDB` читается любым JS
 * того же origin.
 *
 * Сейчас на доступность Облака это НЕ влияет и влиять не должно: ключа на
 * пути пользователя нет, хранить в вебе нечего, и запирать веб было бы
 * запретом без причины. Функция оставлена, потому что понадобится снова,
 * когда шифрование вернётся из ключницы, — и потому что её условие
 * по-прежнему верно, просто больше ничего не решает.
 */
export function platformSupportsSecureKeyStorage(platform: PlatformCapabilities): boolean {
  if (platform.kind === 'web') return false;
  return platform.biometrics !== null;
}

/**
 * Доступно ли Облако на этом устройстве.
 *
 * Одно условие вместо прежних двух. Платформенный замок снят намеренно:
 * из-за него облака не было ни в вебе, ни на телефоне без биометрии — то
 * есть у части людей его не было вовсе, и они об этом узнавали, только
 * добравшись до настроек.
 */
export function cloudAvailable(_platform: PlatformCapabilities): boolean {
  return CLOUD_SYNC_ENABLED;
}

export interface ResolveCloudAccessOptions {
  platform: PlatformCapabilities;
  cloudBaseUrl: string;
  /** Уже авторизованный `fetch` — токен ставит вызывающий. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Клиент ключа для этого устройства. Вынесен, чтобы тесты его подменяли. */
export function createOnboarding(options: ResolveCloudAccessOptions): SyncKeyOnboarding {
  return new SyncKeyOnboarding({
    baseUrl: originOf(options.cloudBaseUrl),
    fetch: options.fetch as never,
    biometrics: options.platform.biometrics,
  });
}

/**
 * Где мы находимся.
 *
 * Опрос ключа остался, хотя ключей больше не создают: у аккаунта, успевшего
 * пройти онбординг прошлой схемы, ключ есть, и молча синхронизировать поверх
 * его шифротекста нельзя — сервер такую запись всё равно отобьёт, а человек
 * увидел бы пустое облако без объяснения.
 */
export async function resolveCloudAccess(
  options: ResolveCloudAccessOptions,
  onboarding: SyncKeyOnboarding = createOnboarding(options),
): Promise<CloudAccess> {
  if (!CLOUD_SYNC_ENABLED) return { status: 'cloud_disabled', reason: 'flag' };

  const state = await onboarding.state().catch(() => null);
  if (state === null || state.status === 'unknown') return { status: 'unavailable' };
  if (state.status === 'none') return { status: 'ready' };
  if (state.status === 'needs-code') return { status: 'locked_elsewhere' };
  return { status: 'unlock_required', sync: state.crypto };
}

/**
 * Бэкенд Облака из разрешённого состояния.
 *
 * `unlock_required` получает бэкенд С ключом — иначе он не прочитает
 * шифротекст, который как раз и предстоит перевести. Все остальные рабочие
 * состояния получают обычный бэкенд без шифрования.
 *
 * `null` — не «мягкий отказ»: вызывающий обязан показать человеку состояние,
 * а не синхронизировать молча что-то другое.
 */
export function createCloudBackendFor(
  access: CloudAccess,
  options: CloudBackendOptions,
): ZapiskiCloudBackend | null {
  if (access.status === 'unlock_required') {
    return createCloudBackend({ ...options, sync: access.sync });
  }
  if (access.status === 'ready') return createCloudBackend(options);
  return null;
}
