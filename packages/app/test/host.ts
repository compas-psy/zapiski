/**
 * Тестовый `AppHost`: платформа без единой возможности.
 *
 * Значение `null` у порта — не «заглушка», а полноценный случай: экраны обязаны
 * СКРЫВАТЬ соответствующий элемент, а не показывать выключенным (BEHAVIOR §5.1).
 */
import { MemoryVaultStorage, type PlatformCapabilities, type VaultStorage } from '@zapiski/core';
import type { AppHost, PreferencesStore } from '../src/contract.js';

export function memoryPreferences(seed: Record<string, unknown> = {}): PreferencesStore {
  const values = new Map<string, unknown>(Object.entries(seed));
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      return values.has(key) ? (values.get(key) as T) : fallback;
    },
    async set<T>(key: string, value: T): Promise<void> {
      values.set(key, value);
      for (const handler of listeners.get(key) ?? []) handler(value);
    },
    subscribe(key, handler) {
      const set = listeners.get(key) ?? new Set();
      set.add(handler);
      listeners.set(key, set);
      return () => set.delete(handler);
    },
  };
}

export interface TestHostOptions {
  files?: Record<string, string>;
  platform?: Partial<PlatformCapabilities>;
  prefs?: Record<string, unknown>;
}

/** Что делает поддельный модуль при `unlock`: отдать ключ, отказать, отменить. */
export interface FakeBiometrics {
  provider: NonNullable<PlatformCapabilities['biometrics']>;
  /** Что лежит в «защищённом модуле». `null` — не заводили или сняли. */
  stored(): Uint8Array | null;
  /** Человек нажал «Отмена» — по контракту это `null`, а не ошибка. */
  cancel(on: boolean): void;
  /** Сколько раз спрашивали палец. */
  unlocks(): number;
}

/**
 * Поддельный модуль биометрии, повторяющий контракт платформы.
 *
 * До него в тестовом хосте стоял `biometrics: null`, и весь путь «включить
 * отпечаток → открыть им заметку» не проверялся НИ РАЗУ. Через эту дыру
 * прошли сразу три дефекта: включение по непроверенному паролю, ненаписанная
 * настройка `security.biometrics` и молчаливый отказ при устаревшей привязке.
 *
 * Подделка честная: она хранит ровно то, что дали в `enroll`, и отдаёт ровно
 * это в `unlock`. Никакой «проверки пароля» внутри — её и не должно быть на
 * этом уровне, иначе тест проверял бы подделку, а не продукт.
 */
export function fakeBiometrics(): FakeBiometrics {
  let secret: Uint8Array | null = null;
  let cancelled = false;
  let unlocks = 0;
  return {
    provider: {
      async isAvailable() {
        return true;
      },
      async enroll(_keyId, value) {
        secret = Uint8Array.from(value);
      },
      async unlock() {
        unlocks += 1;
        if (cancelled || !secret) return null;
        return Uint8Array.from(secret);
      },
      async remove() {
        secret = null;
      },
    },
    stored: () => secret,
    cancel: (on) => {
      cancelled = on;
    },
    unlocks: () => unlocks,
  };
}

export function createTestHost(options: TestHostOptions = {}): AppHost & {
  storage: VaultStorage;
  saved: Array<{ name: string; mime: string; size: number }>;
} {
  const storage = new MemoryVaultStorage(options.files ? { files: options.files } : {});
  const saved: Array<{ name: string; mime: string; size: number }> = [];

  const platform: PlatformCapabilities = {
    kind: 'web',
    version: '0.0.0-test',
    biometrics: null,
    haptics: null,
    globalHotkey: null,
    shareTarget: null,
    updater: null,
    secureFlag: () => {},
    pickVaultDirectory: async () => storage,
    ...options.platform,
  };

  return {
    platform,
    prefs: memoryPreferences(options.prefs),
    restoreVault: async () => storage,
    openExternal: async () => {},
    cloudBaseUrl: 'https://zapiski.cmpas.ru/api/v1',
    pdf: null,
    saveFile: async (name, data, mime) => {
      saved.push({ name, mime, size: data.byteLength });
    },
    storage,
    saved,
  };
}
