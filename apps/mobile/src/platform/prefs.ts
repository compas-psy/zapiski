/**
 * `PreferencesStore` — настройки приложения вне vault'а.
 *
 * Тема, акцент, язык, выбранный backend синка. В vault'е им не место: vault
 * может лежать в облаке и быть общим для устройств, а «тёмная тема на
 * телефоне» — свойство телефона.
 *
 * Хранилище — `@tauri-apps/plugin-store`: JSON в приватном каталоге
 * приложения. `autoSave` с задержкой, а не запись на каждый ключ: смена
 * ползунка размера шрифта иначе давала бы десяток записей на диск в секунду.
 */
import { load, type Store } from '@tauri-apps/plugin-store';
import type { PreferencesStore } from '@zapiski/app';

const FILE = 'preferences.json';

export function createPreferences(): PreferencesStore {
  let handle: Promise<Store> | null = null;
  const store = (): Promise<Store> => (handle ??= load(FILE, { autoSave: 300 }));

  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      try {
        const value = await (await store()).get<T>(key);
        return value === undefined || value === null ? fallback : value;
      } catch {
        // Повреждённый файл настроек не должен мешать открыть заметки:
        // ARCHITECTURE §3.9 — ошибка никогда не блокирует работу с текстом.
        return fallback;
      }
    },

    async set<T>(key: string, value: T): Promise<void> {
      await (await store()).set(key, value);
    },

    subscribe(key: string, handler: (value: unknown) => void): () => void {
      let disposed = false;
      let unlisten: (() => void) | null = null;

      void store()
        .then((instance) => instance.onKeyChange(key, (value) => {
          if (!disposed) handler(value);
        }))
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch(() => undefined);

      return () => {
        disposed = true;
        unlisten?.();
      };
    },
  };
}
