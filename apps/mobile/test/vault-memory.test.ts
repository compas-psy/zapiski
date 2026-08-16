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
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Управляемая замена платформенного моста. */
const probe = vi.fn();
/** Разрешения на деревья, которые система якобы помнит за нами. */
const persisted = vi.fn<() => Promise<string[]>>(async () => []);
/** Отпускание разрешений — считаем вызовы: это половина «вернуться в папку». */
const release = vi.fn(async () => undefined);

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
  persistedSafTrees: () => persisted(),
  releaseSafTrees: () => release(),
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

/* Счётчики вызовов не должны перетекать из проверки в проверку: иначе
   утверждение «мост не дёргали» смотрит на чужие вызовы. Умолчание для
   разрешений — пустой список: «система за нами ничего не помнит». */
beforeEach(() => {
  probe.mockReset();
  release.mockClear();
  persisted.mockImplementation(async () => []);
});

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
       удовлетворить, вообще перестав забывать адрес.

       «Действительно нет» — это ДВА совпавших ответа: проверка не подтвердила
       дерево И система больше не держит за нами разрешение на него. */
    probe.mockImplementation(async () => null);
    persisted.mockImplementation(async () => []);
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(prefs.store.get(PREF_SAF_TREE)).toBeNull();
    expect(where?.kind).toBe('app');
  });

  it('папка молчит, но разрешение на месте — выбор остаётся', async () => {
    /*
     * Утро после перезагрузки телефона. Провайдер папки — свой у карты памяти,
     * свой у клиента облачного диска — ещё не поднят, и проверка дерева
     * отвечает «не подтверждаю». Разрешение при этом никуда не делось: человек
     * ничего не отзывал.
     *
     * Заказчик описал последствие прежнего поведения тремя словами: «снова
     * утро, снова пустота» — приложение забывало папку и открывало пустой
     * каталог приложения, где заметок нет и не было.
     */
    probe.mockImplementation(async () => null);
    persisted.mockImplementation(async () => ['content://tree/notes']);
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(
      prefs.store.get(PREF_SAF_TREE),
      'непроснувшийся провайдер стёр выбор пользователя',
    ).toBe('content://tree/notes');
    /* И каталог приложения не выдаётся за папку пользователя: `null` — это
       честное «сейчас не знаю», на которое приложение отвечает «Папка
       недоступна…», а не пустым списком. */
    expect(where).toBeNull();
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
  it('папка молчит, а разрешение есть — запуск не забывает выбор', async () => {
    /* То же правило на старте: третье утро подряд заказчик получал пустой
       список именно здесь — приложение решало, что доступа нет, стирало адрес
       и открывало каталог приложения. */
    probe.mockImplementation(async () => null);
    persisted.mockImplementation(async () => ['content://tree/notes']);
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });
    prefsHolder.current = prefs;

    const { createHost } = await import('../src/host');
    const storage = await createHost().restoreVault();

    expect(storage, 'молчащая папка подменена каталогом приложения').toBeNull();
    expect(prefs.store.get(PREF_SAF_TREE)).toBe('content://tree/notes');
  });

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

/**
 * Выбор папки переживает смерть процесса.
 *
 * Отзыв заказчика второго круга: «Android — папка не выбирается и по факту
 * ничего не сохраняется». Механика такая. Настройка пишется в самом конце:
 * система вернула адрес → Rust отдал его в JS → JS записал. Но пока открыт
 * системный выбор, приложение в фоне, а диалог выбора документов тяжёлый — на
 * телефоне со скромной памятью Android спокойно убивает наш процесс. Тогда
 * результат приходит уже в НОВЫЙ процесс: разрешение на папку система выдаёт,
 * а того, кто ждал ответа, больше нет — и до настройки адрес не доезжает.
 * Человек выбрал папку, вернулся, а список прежний: выбор будто не случился.
 *
 * Разрешение при этом никуда не делось. Значит, надёжный след выбора — оно, а
 * настройка лишь его копия. Здесь сторожится и это, и обратная сторона: без
 * отпускания разрешений «вернуться в каталог приложения» перестало бы
 * работать — восстановление утащило бы человека обратно.
 */
describe('выбор папки переживает смерть процесса', () => {
  it('настройки пусты, а разрешение есть — папка возвращается', async () => {
    persisted.mockImplementation(async () => ['content://tree/notes']);
    probe.mockImplementation(async () => ({
      uri: 'content://tree/notes',
      label: 'Заметки',
      supportsRename: true,
    }));
    const prefs = memoryPrefs();

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(where?.kind, 'выбранная папка не восстановилась').toBe('user');
    expect(where?.label).toBe('Заметки');
    /* И копия чинится, чтобы следующий запуск не спрашивал систему заново. */
    expect(prefs.store.get(PREF_SAF_TREE)).toBe('content://tree/notes');
  });

  it('то же самое при запуске: хранилище открывается по восстановленной папке', async () => {
    persisted.mockImplementation(async () => ['content://tree/notes']);
    probe.mockImplementation(async () => ({
      uri: 'content://tree/notes',
      label: 'Заметки',
      supportsRename: true,
    }));
    const prefs = memoryPrefs();
    prefsHolder.current = prefs;

    const { createHost } = await import('../src/host');
    const storage = await createHost().restoreVault();

    expect(storage, 'запуск не нашёл выбранную папку').toEqual({
      kind: 'saf',
      tree: 'content://tree/notes',
    });
  });

  it('разрешений нет — каталог приложения, и ничего не выдумываем', async () => {
    persisted.mockImplementation(async () => []);
    const prefs = memoryPrefs();

    const platform = createPlatform(prefs as never);
    const where = await platform.vaultFolders?.current();

    expect(where?.kind).toBe('app');
    expect(probe, 'нечего проверять — а мост всё-таки дёрнули').not.toHaveBeenCalled();
  });

  it('возврат в каталог приложения отпускает разрешение', async () => {
    persisted.mockImplementation(async () => ['content://tree/notes']);
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: 'content://tree/notes' });

    const platform = createPlatform(prefs as never);
    /* Каталог приложения открывается настоящим мостом, которого в тестах нет,
       — но нас интересует то, что случилось ДО него. */
    await platform.vaultFolders?.useAppFolder().catch(() => null);

    expect(release, 'разрешение осталось у нас — выбор вернётся сам собой').toHaveBeenCalled();
    expect(prefs.store.get(PREF_SAF_TREE)).toBeNull();
  });
});
