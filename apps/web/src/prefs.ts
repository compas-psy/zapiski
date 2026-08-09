/**
 * `PreferencesStore` для веба: настройки вне vault'а (тема, акцент, язык,
 * выбранный бэкенд). Живут в `localStorage` — они не заметки и на диск
 * пользователя не претендуют.
 *
 * `subscribe` нужен, чтобы смена настройки применялась мгновенно и в соседней
 * вкладке тоже (BEHAVIOR §10): событие `storage` приходит именно оттуда.
 */
import type { PreferencesStore } from '@zapiski/app';

const NAMESPACE = 'zapiski.prefs.';

export function createWebPreferences(storage: Storage | null = safeStorage()): PreferencesStore {
  const listeners = new Map<string, Set<(value: unknown) => void>>();

  if (storage && typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (!event.key || !event.key.startsWith(NAMESPACE)) return;
      const key = event.key.slice(NAMESPACE.length);
      const handlers = listeners.get(key);
      if (!handlers) return;
      const value = event.newValue === null ? null : parse(event.newValue, null);
      for (const handler of handlers) handler(value);
    });
  }

  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      const raw = storage?.getItem(NAMESPACE + key);
      return raw === null || raw === undefined ? fallback : parse(raw, fallback);
    },

    async set<T>(key: string, value: T): Promise<void> {
      try {
        storage?.setItem(NAMESPACE + key, JSON.stringify(value));
      } catch {
        /* Квота или приватный режим: настройка не переживёт перезапуск —
           это не повод ломать работу с заметками. */
      }
      for (const handler of listeners.get(key) ?? []) handler(value);
    },

    subscribe(key: string, handler: (value: unknown) => void): () => void {
      const set = listeners.get(key) ?? new Set();
      set.add(handler as (value: unknown) => void);
      listeners.set(key, set);
      return () => set.delete(handler as (value: unknown) => void);
    },
  };
}

function parse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** В приватном режиме обращение к localStorage может бросать. */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
