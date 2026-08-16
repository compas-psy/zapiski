/**
 * `restoreVault` на Android: свежая установка и вход в облако.
 *
 * Заказчик, третий круг: «переустановил и сразу не подключал облако — папка
 * недоступна. Сразу подключил облако после новой переустановки — папка
 * недоступна». До работы над учётками папка открывалась.
 *
 * Гадать больше нельзя, поэтому здесь воспроизводится ровно тот путь, который
 * идёт на устройстве: настоящий `createHost().restoreVault` поверх
 * подделанных моста и каталога приложения. Если ошибка в нашей логике — тест
 * её назовёт; если тест зелёный — значит, ошибка в нативной части, и искать
 * надо там.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.fn(async (tree: string) => ({ uri: tree, label: 'Заметки' }));
const persisted = vi.fn<() => Promise<string[]>>(async () => []);

/** Какие корни просили открыть — по ним видно, куда приложение целится. */
const opened: string[] = [];
/** Корни, которые «не открываются»: так подделывается отказ ФС. */
const broken = new Set<string>();

const prefsHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../src/platform/prefs', () => ({ createPreferences: () => prefsHolder.current }));

vi.mock('../src/platform/saf', () => ({
  probeSafTree: (tree: string) => probe(tree),
  pickSafTree: async () => null,
  createSafStorage: (tree: string) => ({ kind: 'saf', tree }),
  writeModeOf: () => 'direct' as const,
  persistedSafTrees: () => persisted(),
  releaseSafTrees: async () => undefined,
  openSafFile: async () => false,
}));

vi.mock('../src/platform/vault', () => ({
  defaultVaultRoot: async () => '/data/Записки',
  openVault: async (root: string) => {
    opened.push(root);
    return broken.has(root) ? null : { kind: 'fs', root };
  },
  currentVaultRoot: async () => null,
  createVaultStorage: (root: string) => ({ kind: 'fs', root }),
}));

/* Остальные платформенные модули хоста в этом тесте не участвуют, но он их
   импортирует — подделываем минимально. */
vi.mock('../src/platform/auth', () => ({
  onAuthCallback: () => () => undefined,
  takeInitialAuthCallback: async () => null,
}));
vi.mock('../src/platform/back', () => ({ onSystemBack: () => () => undefined }));
vi.mock('../src/platform/files', () => ({ saveFile: async () => undefined }));
vi.mock('../src/platform/pdf', () => ({ createPdfRenderer: () => null }));
vi.mock('../src/platform/biometrics', () => ({ createBiometrics: () => null }));
vi.mock('../src/platform/haptics', () => ({ createHaptics: () => null }));
vi.mock('../src/platform/share', () => ({
  createShareTarget: () => null,
  createShareOut: () => null,
}));
vi.mock('../src/platform/updater', () => ({ createUpdater: () => null }));
vi.mock('../src/platform/ipc', () => ({
  call: async () => {
    throw new Error('нативный мост в тестах недоступен');
  },
  on: () => () => undefined,
  COMMANDS: new Proxy({}, { get: (_t, key) => String(key) }),
  EVENTS: new Proxy({}, { get: (_t, key) => String(key) }),
}));

const { createHost } = await import('../src/host');

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

beforeEach(() => {
  opened.length = 0;
  broken.clear();
  probe.mockImplementation(async (tree: string) => ({ uri: tree, label: 'Заметки' }));
  persisted.mockImplementation(async () => []);
});

describe('свежая установка', () => {
  it('без облака хранилище открывается в каталоге приложения', async () => {
    prefsHolder.current = memoryPrefs();
    const host = createHost();

    const storage = await host.restoreVault('local');

    expect(storage, 'на свежей установке папка объявлена недоступной').not.toBeNull();
    expect(opened).toEqual(['/data/Записки']);
  });

  it('вход в облако не прячет заметки в подпапку', async () => {
    /*
     * Главный сторож этой истории.
     *
     * Разводя учётки, я завёл каждому владельцу подпапку `.owners/<ключ>`
     * внутри каталога приложения. Человек держал заметки в каталоге, вошёл в
     * облако — и приложение открыло пустую подпапку: заметки рядом, целые,
     * невидимые. На экране это «Файлов 0» и «папка недоступна».
     *
     * Каталог приложения — место УСТРОЙСТВА, а не учётки. Разделение по
     * владельцам держится там, где человек выбирает место сам.
     */
    const prefs = memoryPrefs();
    prefsHolder.current = prefs;
    const host = createHost();

    await host.restoreVault('local');
    const storage = await host.restoreVault('ivan@ya.ru');

    expect(storage, 'после входа папка объявлена недоступной').not.toBeNull();
    expect(opened[1], 'заметки спрятаны в подпапку учётки').toBe('/data/Записки');
  });

  it('вход в облако ПЕРВЫМ действием отдаёт учётке корень, а не подпапку', async () => {
    /* Человек переустановил приложение и сразу подключил облако. Никто до него
       каталог не занимал — значит корень достаётся ему, и заметки лягут туда,
       где их видно из компьютера по USB. */
    prefsHolder.current = memoryPrefs();
    const host = createHost();

    const storage = await host.restoreVault('ivan@ya.ru');

    expect(storage).not.toBeNull();
    expect(opened).toEqual(['/data/Записки']);
  });
});

describe('каталог приложения не открылся', () => {
  it('это и есть «папка недоступна» — единственный честный случай', async () => {
    prefsHolder.current = memoryPrefs();
    broken.add('/data/Записки');
    const host = createHost();

    expect(await host.restoreVault('local')).toBeNull();
  });
});
