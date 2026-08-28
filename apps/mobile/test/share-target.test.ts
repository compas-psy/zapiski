/**
 * `ShareTargetProvider` — приём контента из системного «Поделиться»
 * (BEHAVIOR §8), включая файл `.md` (ТЗ §5.4: «в Telegram прислали .md файл
 * → поделиться → в выборе есть ЗАПИСКИ → окно выбора папки»).
 *
 * `kind: 'file'` — самый новый из четырёх видов payload'а, и единственный,
 * несущий имя файла: без него заголовок заметки после импорта потерялся бы
 * (см. `packages/app/src/screens/ShareSheet.tsx`, `sharedText`/`add`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async () => [] as unknown[]);
const listeners = new Map<string, (payload: unknown) => void>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (message: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }));
    return () => listeners.delete(event);
  },
}));

const { createShareTarget } = await import('../src/platform/share');
const { EVENTS } = await import('../src/platform/ipc');

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  listeners.clear();
});

describe('файл .md через «Поделиться»', () => {
  it('имя файла доезжает вместе с байтами', async () => {
    const received: unknown[] = [];
    createShareTarget().onShare((payload) => received.push(payload));
    await flush();

    listeners.get(EVENTS.share)?.({
      kind: 'file',
      name: 'Идея.md',
      bytes: [35, 32, 208, 152, 208, 180, 208, 181, 209, 143],
    });

    expect(received).toEqual([
      {
        kind: 'file',
        name: 'Идея.md',
        bytes: Uint8Array.from([35, 32, 208, 152, 208, 180, 208, 181, 209, 143]),
      },
    ]);
  });

  it('холодный старт: файл, оставленный до запуска, доезжает через share_take', async () => {
    invoke.mockResolvedValue([{ kind: 'file', name: 'Заметка.md', bytes: [1, 2, 3] }]);

    const received: unknown[] = [];
    createShareTarget().onShare((payload) => received.push(payload));
    await flush();

    expect(received).toEqual([
      { kind: 'file', name: 'Заметка.md', bytes: Uint8Array.from([1, 2, 3]) },
    ]);
  });

  it('текст и ссылка по-прежнему без имени файла', async () => {
    const received: unknown[] = [];
    createShareTarget().onShare((payload) => received.push(payload));
    await flush();

    listeners.get(EVENTS.share)?.({ kind: 'text', text: 'просто текст' });

    expect(received).toEqual([{ kind: 'text', text: 'просто текст' }]);
  });
});
