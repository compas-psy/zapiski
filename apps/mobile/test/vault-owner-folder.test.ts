/**
 * Папка учётки на Android: вопрос не занимает папку, ответ не отбирает чужую.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Порт `vaultFolders` не знал про владельца — ни один из трёх методов его не
 * принимал. Три следствия, и все три заказчик увидел за один вечер.
 *
 * 1. `current()` — вопрос «где сейчас папка» — по дороге ЗАНИМАЛ старую папку
 *    за `local`, потому что владельца ему не передавали. А `boot()` задавал
 *    этот вопрос ДО восстановления сессии. Значит, у любого, кто вошёл в
 *    облако и держал заметки в выбранной папке, папка при первом же запуске
 *    новой сборки доставалась `local`, а учётка получала пустую подпапку.
 *    Синхронизация после этого работала — с пустотой; на экране это
 *    «не могу синхронизироваться с облаком».
 * 2. `chooseFolder()` писала выбор в общую ячейку, а читался ключ владельца.
 *    Выбранная под учёткой папка не доставалась ей при следующем запуске.
 * 3. `useAppFolder()` снимала SAF-разрешения на ВСЕ деревья: возврат одного
 *    владельца в каталог приложения отбирал папку у остальных.
 *
 * ── Правило, которое здесь сторожится ───────────────────────────────────────
 *
 * Вопрос не меняет мира. Заявку на папку делает тот, кто ОТКРЫВАЕТ хранилище
 * (`adoptSafTree`), и делает её за себя. Чужая папка не забирается ни при
 * отзыве доступа, ни при возврате в каталог приложения.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.fn(async (tree: string) => ({ uri: tree, label: 'Заметки' }));
const persisted = vi.fn<() => Promise<string[]>>(async () => []);
const release = vi.fn(async () => undefined);
const pick = vi.fn<() => Promise<{ uri: string; label: string } | null>>(async () => null);

vi.mock('../src/platform/saf', () => ({
  probeSafTree: (tree: string) => probe(tree),
  pickSafTree: () => pick(),
  createSafStorage: (tree: string) => ({ kind: 'saf', tree }),
  writeModeOf: () => 'direct' as const,
  persistedSafTrees: () => persisted(),
  releaseSafTrees: () => release(),
}));

/* Каталог приложения подделан целиком: настоящий спрашивает Android, а
   проверяется здесь не он, а то, ЧЕЙ корень открывают. */
vi.mock('../src/platform/vault', () => ({
  defaultVaultRoot: async () => '/base',
  openVault: async (root: string) => ({ kind: 'fs', root }),
  currentVaultRoot: async () => null,
  createVaultStorage: (root: string) => ({ kind: 'fs', root }),
}));

vi.mock('../src/platform/ipc', () => ({
  call: async () => {
    throw new Error('нативный мост в тестах недоступен');
  },
  on: () => () => undefined,
  COMMANDS: new Proxy({}, { get: (_target, key) => String(key) }),
  EVENTS: new Proxy({}, { get: (_target, key) => String(key) }),
}));

const {
  APP_FOLDER_CHOICE,
  adoptSafTree,
  chosenSafTree,
  createPlatform,
  forgetTree,
  ownedRoot,
  PREF_SAF_OWNERS,
  PREF_SAF_TREE,
  safTreeKeyOf,
} = await import('../src/platform/capabilities');

const TREE = 'content://tree/notes';
const OTHER = 'content://tree/other';
const USER = 'ivan@ya.ru';

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

/** Настройки, которые отказываются писать: диск занят, файл не открылся. */
function brokenPrefs(initial: Record<string, unknown> = {}) {
  const prefs = memoryPrefs(initial);
  return {
    ...prefs,
    async set(): Promise<void> {
      throw new Error('настройки не записались');
    },
  };
}

beforeEach(() => {
  probe.mockImplementation(async (tree: string) => ({ uri: tree, label: 'Заметки' }));
  persisted.mockImplementation(async () => []);
  release.mockClear();
  pick.mockImplementation(async () => null);
});

describe('вопрос «где папка» ничего не занимает', () => {
  it('current() ничего не пишет в настройки', async () => {
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: TREE });
    const before = new Map(prefs.store);
    const platform = createPlatform(prefs as never);

    await platform.vaultFolders?.current();

    expect([...prefs.store.entries()], 'вопрос о папке изменил настройки').toEqual([
      ...before.entries(),
    ]);
  });

  it('старая папка достаётся любому владельцу, у кого своей ещё нет', async () => {
    /*
     * Здесь стоял глобальный флаг «кто занял папку», и он же был костылём:
     * один на всё приложение, ни от чего не зависящий. Пока он стоял на одном
     * владельце, `chosenSafTree` отвечал другому «твоего тут нет» — а это
     * значит каталог приложения. Человек, сменивший учётку, упорно попадал не
     * в свою папку, сколько бы раз её ни выбирал.
     *
     * Папка на устройстве одна. Прятать её от того, кто в неё же складывал
     * заметки, не за что.
     */
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: TREE });

    expect(await chosenSafTree(prefs as never, 'local')).toBe(TREE);
    expect(await chosenSafTree(prefs as never, USER)).toBe(TREE);
  });

  it('свой выбор владельца сильнее старой общей ячейки', async () => {
    const prefs = memoryPrefs({ [PREF_SAF_TREE]: TREE, [safTreeKeyOf(USER)]: OTHER });

    expect(await chosenSafTree(prefs as never, USER)).toBe(OTHER);
    expect(await chosenSafTree(prefs as never, 'local')).toBe(TREE);
  });
});

describe('выбор папки достаётся тому, кто выбирал', () => {
  it('chooseFolder пишет владельцу, а не в общую ячейку', async () => {
    pick.mockImplementation(async () => ({ uri: TREE, label: 'Заметки' }));
    const prefs = memoryPrefs();
    const platform = createPlatform(prefs as never);

    await platform.vaultFolders?.chooseFolder(USER);

    expect(prefs.store.get(safTreeKeyOf(USER))).toBe(TREE);
    /* И следующий запуск отдаёт её тому же владельцу. */
    expect(await chosenSafTree(prefs as never, USER)).toBe(TREE);
  });
});

describe('возврат в каталог приложения не трогает чужие папки', () => {
  it('разрешения снимаются, только если больше ни у кого папки нет', async () => {
    pick.mockImplementation(async () => ({ uri: TREE, label: 'Заметки' }));
    const prefs = memoryPrefs();
    const platform = createPlatform(prefs as never);

    await platform.vaultFolders?.chooseFolder('local');
    prefs.store.set(safTreeKeyOf(USER), OTHER);
    prefs.store.set(PREF_SAF_OWNERS, ['local', USER]);

    await platform.vaultFolders?.useAppFolder('local');

    expect(release, 'возврат одного владельца отобрал папку у другого').not.toHaveBeenCalled();
    expect(prefs.store.get(safTreeKeyOf(USER))).toBe(OTHER);
    /* А сам ушедший записан явно: восстановление по разрешению не утащит его
       назад в покинутую папку. */
    expect(prefs.store.get(safTreeKeyOf('local'))).toBe(APP_FOLDER_CHOICE);
    expect(await chosenSafTree(prefs as never, 'local')).toBeNull();
  });

  it('последний уходящий разрешения отпускает', async () => {
    pick.mockImplementation(async () => ({ uri: TREE, label: 'Заметки' }));
    const prefs = memoryPrefs();
    const platform = createPlatform(prefs as never);

    await platform.vaultFolders?.chooseFolder('local');
    await platform.vaultFolders?.useAppFolder('local');

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('явный отказ не переигрывается разрешением, оставшимся в системе', async () => {
    const prefs = memoryPrefs({ [safTreeKeyOf('local')]: APP_FOLDER_CHOICE });
    persisted.mockImplementation(async () => [TREE]);

    expect(
      await adoptSafTree(prefs as never, 'local'),
      'разрешение вернуло человека в папку, из которой он ушёл',
    ).toBeNull();
  });
});

describe('отзыв доступа у одного не стирает папку у другого', () => {
  it('общая ячейка чистится, только если её держит тот же владелец', async () => {
    const prefs = memoryPrefs({
      [PREF_SAF_TREE]: TREE,
      [safTreeKeyOf(USER)]: OTHER,
    });

    await forgetTree(prefs as never, USER, OTHER);

    expect(prefs.store.get(safTreeKeyOf(USER))).toBeNull();
    expect(prefs.store.get(PREF_SAF_TREE), 'забыли чужую папку').toBe(TREE);
  });
});

describe('незаписанная настройка — это не пропавшая папка', () => {
  it('ownedRoot отдаёт корень, даже если заявку записать не вышло', async () => {
    /*
     * `prefs.set` бросает. Раньше исключение летело сквозь `ownedRoot` в
     * онбординг, а тот трактует ЛЮБОЕ исключение как «папка недоступна»:
     * показывает тост и уводит человека в хранилище в памяти. То есть сбой
     * записи настройки выдавался за пропавшую папку.
     */
    const prefs = brokenPrefs();

    await expect(ownedRoot('/base')).resolves.toBe('/base');
  });

  it('adoptSafTree отдаёт папку, даже если заявку записать не вышло', async () => {
    const prefs = brokenPrefs({ [PREF_SAF_TREE]: TREE });

    await expect(adoptSafTree(prefs as never, USER)).resolves.toBe(TREE);
  });
});
