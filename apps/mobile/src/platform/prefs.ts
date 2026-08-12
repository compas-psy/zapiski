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

  /*
   * Сброс на диск, когда приложение уходит в фон.
   *
   * `autoSave: 300` означает окно в 300 мс между «пользователь переключил
   * тумблер» и «значение легло в файл». Android убивает фоновый процесс без
   * предупреждения (об этом же сказано в `platform/vault.ts` про заметки), и
   * попасть в это окно проще всего именно так: изменил настройку — свернул
   * приложение. Настройка молча возвращается к прежней, и это ровно тот
   * симптом, который заказчик описывает как «настройки не работают».
   *
   * `visibilitychange` — то же событие, на котором `packages/app` сбрасывает
   * текст заметки; настройки заслуживают не меньшего. `pagehide` добавлен
   * потому, что при выгрузке страницы `visibilitychange` может не прийти.
   */
  if (typeof document !== 'undefined') {
    const flush = (): void => {
      if (handle === null) return; // хранилище ещё не открывали — сбрасывать нечего
      void handle.then((instance) => instance.save()).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  }

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
