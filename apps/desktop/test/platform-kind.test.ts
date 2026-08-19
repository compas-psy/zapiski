/**
 * Что уезжает серверу в поле `platform` — и почему это не косметика.
 *
 * ── Откуда взялась проверка ─────────────────────────────────────────────────
 *
 * Ветка `feature/macos-dmg` тронула контракт платформы: `kind` перестал быть
 * литералом `'windows'` и стал ответом на вопрос к Rust. Заказчик отказался
 * вливать ветку до фактической проверки, и он прав по существу: `kind` — это
 * не подпись в «О программе». Он уезжает в теле POST `/auth/magic-link`,
 * сервер по нему выбирает адрес возврата, и от этого зависит, откроется ли
 * письмо в приложении или оставит человека на сайте. Вход по почте — блокер
 * релиза MVP, то есть цена ошибки здесь максимальная.
 *
 * ── Что именно доказывается ─────────────────────────────────────────────────
 *
 * Не «функция возвращает строку», а весь путь: ответ IPC → `createCapabilities`
 * → `SessionStore.requestMagicLink` → байты HTTP-запроса. Утверждения читают
 * тело настоящего запроса, а не внутреннее поле объекта.
 *
 * Главное утверждение — про отказы. На Windows поле обязано быть `'windows'`
 * во ВСЕХ состояниях IPC: ответил правильно, ответил мусором, отказал, молчит.
 * Иначе правка внешнего вида ломает вход, и узнаётся это на чужой машине.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── Оболочка Tauri, которой в node нет ─────────────────────────────────────
   Подменяется ровно то, что уходит за пределы JS. Логика — наша, настоящая. */

const invokeMock = vi.fn<(command: string) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => null }));
vi.mock('@tauri-apps/plugin-store', () => ({ load: async () => ({}) }));
vi.mock('@tauri-apps/plugin-fs', () => ({}));

type Kind = 'web' | 'windows' | 'macos' | 'android';

/** Что ответил Rust — и что после этого уезжает серверу. */
interface Trace {
  kind: Kind;
  /** Тело POST `/auth/magic-link`, как его увидел бы сервер. */
  body: Record<string, unknown>;
  url: string;
}

/**
 * Один прогон: свежий модульный реестр (ответ IPC кэшируется на сеанс),
 * настоящие `createCapabilities` и `SessionStore`, поддельная только сеть.
 */
async function traceMagicLink(answer: () => Promise<unknown>): Promise<Trace> {
  vi.resetModules();
  invokeMock.mockReset();
  invokeMock.mockImplementation((command) =>
    command === 'host_os' ? answer() : Promise.reject(new Error(`нет команды ${command}`)),
  );

  const { hostOs } = await import('../src/platform/os');
  const { createCapabilities } = await import('../src/platform/capabilities');
  const { SessionStore } = await import('@zapiski/app');

  const os = await hostOs();
  const platform = createCapabilities({
    os,
    prefs: stubPrefs(),
    strings: { dialog: { pickVault: '' } },
    biometrics: null,
    globalHotkey: stubHotkey(),
    updater: stubUpdater(),
  } as never);

  let seen: { url: string; init?: RequestInit } | null = null;
  const host = {
    platform,
    prefs: stubPrefs(),
    cloudBaseUrl: 'https://zapiski.cmpas.ru/api/v1',
  } as never;

  const store = new SessionStore(host, {
    fetch: async (url, init) => {
      seen = { url, init };
      return new Response(null, { status: 202 });
    },
  });

  await store.requestMagicLink('kto-to@example.org', { marketing: false });

  if (seen === null) throw new Error('запрос не ушёл вовсе');
  const sent = seen as { url: string; init?: RequestInit };
  return {
    kind: platform.kind,
    url: sent.url,
    body: JSON.parse(String(sent.init?.body)) as Record<string, unknown>,
  };
}

/* Хранилище настроек: `SessionStore` держит в нём device_id, больше ничего. */
function stubPrefs(): { get: unknown; set: unknown; remove: unknown } {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string, fallback: unknown) => (map.has(key) ? map.get(key) : fallback),
    set: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    remove: async (key: string) => {
      map.delete(key);
    },
  };
}

const stubHotkey = (): unknown => ({
  accelerator: 'Ctrl+Alt+N',
  register: async () => true,
  unregister: async () => {},
});
const stubUpdater = (): unknown => ({ check: async () => null, install: async () => {} });

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Windows: платформа в запросе ссылки для входа', () => {
  it('Rust ответил «windows» — серверу уезжает windows', async () => {
    const trace = await traceMagicLink(async () => 'windows');
    expect(trace.kind).toBe('windows');
    expect(trace.body['platform']).toBe('windows');
  });

  it('IPC отказал — всё равно windows, а не пустота', async () => {
    /* Команда может не найтись на старой сборке оболочки: фронтенд и Rust
       обновляются одним пакетом, но у человека на диске бывает что угодно. */
    const trace = await traceMagicLink(async () => {
      throw new Error('Command host_os not found');
    });
    expect(trace.body['platform']).toBe('windows');
  });

  it('IPC ответил мусором — всё равно windows', async () => {
    const trace = await traceMagicLink(async () => 'FreeBSD');
    expect(trace.body['platform']).toBe('windows');
  });

  it('IPC ответил не строкой — всё равно windows', async () => {
    const trace = await traceMagicLink(async () => ({ os: 'windows' }));
    expect(trace.body['platform']).toBe('windows');
  });

  it('IPC молчит — запуск не встаёт колом, платформа windows', async () => {
    /*
     * Самый неприятный случай и единственный, который `catch` не ловит.
     * Вопрос задаётся ДО первого кадра: неисполнившееся обещание оставило бы
     * человека перед пустым окном навсегда — без экрана входа, без ошибки,
     * без объяснения.
     */
    const { HOST_OS_TIMEOUT_MS } = await import('../src/platform/os');
    const trace = await Promise.race([
      traceMagicLink(() => new Promise<never>(() => {})),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('оболочка не поднялась: ответа IPC ждали дольше срока')),
          HOST_OS_TIMEOUT_MS * 4,
        );
      }),
    ]);
    expect(trace.body['platform']).toBe('windows');
  });
});

describe('macOS: платформа в том же запросе', () => {
  it('Rust ответил «macos» — серверу уезжает macos', async () => {
    const trace = await traceMagicLink(async () => 'macos');
    expect(trace.kind).toBe('macos');
    expect(trace.body['platform']).toBe('macos');
  });
});

describe('форма запроса не изменилась', () => {
  it('уходит на ту же ручку и с теми же полями, что и до правки', async () => {
    const trace = await traceMagicLink(async () => 'windows');
    expect(trace.url).toBe('https://zapiski.cmpas.ru/api/v1/auth/magic-link');
    /* Поля перечислены поимённо: лишнее поле в теле — такая же поломка
       контракта, как пропавшее, и сервер о нём не просил. */
    expect(Object.keys(trace.body).sort()).toEqual([
      'acceptedTerms',
      'deviceId',
      'email',
      'marketingOptIn',
      'platform',
    ]);
    expect(String(trace.body['deviceId'])).toMatch(/^dev-[0-9a-f]{32}$/);
  });
});
