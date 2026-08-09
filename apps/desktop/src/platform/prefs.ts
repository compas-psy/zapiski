/**
 * `PreferencesStore` — настройки приложения вне vault'а (тема, акцент, язык,
 * выбранный backend). Лежат в `%APPDATA%/ru.cmpas.zapiski/prefs.json`, а не в
 * vault'е: vault синхронизируется между устройствами, а тема — свойство
 * конкретной машины.
 */
import { load, type Store, type UnlistenFn } from '@tauri-apps/plugin-store';
import type { PreferencesStore } from '@zapiski/app';

const FILE = 'prefs.json';

/** Пауза автосохранения: настройки меняются пачками (ползунок размера шрифта). */
const AUTOSAVE_MS = 300;

export class NativePreferences implements PreferencesStore {
  private opened: Promise<Store> | null = null;

  private store(): Promise<Store> {
    this.opened ??= load(FILE, { autoSave: AUTOSAVE_MS });
    return this.opened;
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    const store = await this.store();
    const value = await store.get<T>(key);
    /* Именно `undefined`, а не `??`: `null` — законное сохранённое значение
       («автозамок: до выхода из приложения»), и подменять его умолчанием
       значило бы молча включать замок, который пользователь выключил. */
    return value === undefined ? fallback : value;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const store = await this.store();
    await store.set(key, value);
  }

  /**
   * Подписка обязана быть синхронной (контракт `PreferencesStore`), а хранилище
   * открывается асинхронно. Поэтому отписка запоминает намерение: если
   * подписчик ушёл раньше, чем хранилище открылось, слушатель снимается сразу
   * после открытия и ни одного события не получает.
   */
  subscribe(key: string, handler: (value: unknown) => void): () => void {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void this.store()
      .then((store) => store.onKeyChange(key, (value) => handler(value)))
      .then((stop) => {
        if (cancelled) void stop();
        else unlisten = stop;
      })
      .catch(() => {
        /* Настройки не открылись — приложение работает на умолчаниях, но
           падать из-за этого не должно. */
      });

    return () => {
      cancelled = true;
      if (unlisten !== null) void unlisten();
    };
  }
}

/** Ключи, которыми пользуется сама оболочка. Всё остальное — ключи `packages/app`. */
export const SHELL_PREF = {
  /** Последний открытый каталог vault'а — для `restoreVault()`. */
  vaultPath: 'desktop.vaultPath',
  /** Глобальный хоткей быстрой заметки (BEHAVIOR §7, по умолчанию Ctrl+Alt+N). */
  globalHotkey: 'desktop.globalHotkey',
  /** Язык — тот же ключ, что читает `packages/app`. */
  locale: 'locale',
} as const;
