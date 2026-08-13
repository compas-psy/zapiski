/**
 * Выбор папки — это данные пользователя, а не кеш.
 *
 * Отзыв заказчика: «Самый главный косяк — не выбирается папка, где хранить
 * заметки. При переключении тем папка просто теряется…»
 *
 * Механика потери. Экран спрашивает у платформы, где сейчас лежат заметки;
 * платформа проверяет SAF-дерево через IPC. Проверка писалась как
 * `probeSafTree(uri).catch(() => null)` — и любой отрицательный исход, хоть
 * отозванное разрешение, хоть не ответивший мост, стирал сохранённый адрес.
 * Смена темы перерисовывает экран, экран спрашивает снова — достаточно одного
 * молчания, чтобы папка забылась навсегда. Заметки при этом на месте: мы
 * просто перестаём знать, где они, и дороги назад нет.
 *
 * Правило, которое здесь сторожится: **забыть выбор пользователя можно
 * только по явному ответу «доступа нет»**. Молчание — это «сейчас не знаю»,
 * и оно не даёт права распоряжаться чужими данными.
 *
 * Тест держит правило для ОБОИХ мест, где оно должно действовать: и для
 * `restoreVault` в host.ts, и для `vaultFolders.current()` в capabilities.ts.
 * Первый раз чинилось только одно из них — второе осталось и дожило до
 * отзыва.
 */
import { describe, expect, it, vi } from 'vitest';

/** Управляемая замена платформенного моста. */
const probe = vi.fn();

/* Настройки для `createHost`: он собирает их сам, поэтому подменяется весь
   модуль. `vi.hoisted` нужен потому, что фабрики `vi.mock` поднимаются выше
   объявлений — без него ссылка на держатель была бы ещё не создана. */
const prefsHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../src/platform/prefs', () => ({
  createPreferences: () => prefsHolder.current,
}));

vi.mock('../src/platform/saf', () => ({
  probeSafTree: (tree: string) => probe(tree),
  pickSafTree: async () => null,
  createSafStorage: (tree: string) => ({ kind: 'saf', tree }),
  writeModeOf: () => 'direct' as const,
}));

/* Мост в нативную часть в тестах не поднимается: любой вызов `call` означал бы
   обращение к Android, которого здесь нет. */
vi.mock('../src/platform/ipc', () => ({
  call: async () => {
    throw new Error('нативный мост в тестах недоступен');
  },
  on: () => () => undefined,
  COMMANDS: new Proxy({}, { get: (_target, key) => String(key) }),
  EVENTS: new Proxy({}, { get: (_target, key) => String(key) }),
}));

const { createPlatform, PREF_SAF_TREE } = await import('../src/platform/capabilities');

/** Хранилище настроек в памяти — как `PreferencesStore`, только без диска. */
function memoryPrefs(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    store: values,
    async get<T>(key: string, fallback: T): Promise<T> {
      return values.has(key) ? (values.get(key) as T) : fallback;
    },
    async set<T>(key: string, value: T): Promise<void> {
      values.set(key, value);
    },
    subscribe: () => () => undefined,
  };
}

describe('папка пользователя переживает молчание моста', () => {
  it('IPC не ответил — адрес папки остаётся на месте', async () => {
    /* Именно `mockImplementation`, а не `mockRejectedValue`: последний создаёт
       отклонённый промис в момент настройки мока, и если до него почему-то не
       дойдёт вызов, тест падает необработанным отказом вместо внятного
       утверждения. */
    probe.mockImplementation(async () => {
      throw new Error('мост не ответил');
    });
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(
      prefs.store.get(PREF_SAF_TREE),
      'молчание моста стёрло выбор пользователя',
    ).toBe('content://tree/notes');
    /* И не выдаём каталог приложения за папку пользователя: пустой список из
       чужого места хуже честного «не знаю». */
    expect(where).toBeNull();
  });

  it('доступа действительно нет — адрес забывается', async () => {
    /* Обратная сторона правила: явный ответ «нет доступа» обязан приводить к
       возврату в каталог приложения. Без этой проверки сторож можно было бы
       удовлетворить, вообще перестав забывать адрес. */
    probe.mockImplementation(async () => null);
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(prefs.store.get(PREF_SAF_TREE)).toBeNull();
    expect(where?.kind).toBe('app');
  });

  it('доступ есть — папка пользователя и остаётся папкой пользователя', async () => {
    probe.mockImplementation(async () => ({
      uri: 'content://tree/notes',
      label: 'Заметки',
      supportsRename: true,
    }));
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(where?.kind).toBe('user');
    expect(where?.label).toBe('Заметки');
  });
});

/**
 * Второе место, где действует то же правило.
 *
 * `restoreVault` уже чинили — но чинили ИМЕННО ЕГО, а не правило, поэтому
 * `current()` остался с прежним дефектом и дожил до отзыва заказчика. Тест
 * держит оба места, чтобы «починено» означало «везде».
 */
describe('открытие хранилища на старте', () => {
  it('молчание моста не стирает выбранную папку', async () => {
    probe.mockImplementation(async () => {
      throw new Error('мост не ответил');
    });

    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });
    prefsHolder.current = prefs;

    const { createHost } = await import('../src/host');
    const storage = await createHost().restoreVault();

    /* Хранилище не открылось — и это правильный ответ: «сейчас не знаю, где
       заметки». Неправильным было бы молча открыть каталог приложения. */
    expect(storage).toBeNull();
    expect(
      prefs.store.get(PREF_SAF_TREE),
      'молчание моста стёрло выбор пользователя при запуске',
    ).toBe('content://tree/notes');
  });
});
