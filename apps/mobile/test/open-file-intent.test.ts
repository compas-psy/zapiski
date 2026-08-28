/**
 * Ассоциация `.md` на Android: «Открыть с помощью» и «Поделиться» из
 * Telegram (ТЗ §5.4).
 *
 * Порт `AppHost.onIntent` уже был реализован для плитки и виджета
 * («Записать»); здесь та же дорога для события `open-file` и для холодного
 * старта — путь, оставленный до запуска приложения, лежит в очереди Rust'а
 * (`open_file_take`), и подписка обязана его забрать сама, той же дорогой,
 * что и `share_take()` у «Поделиться».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (command: string) => {
  if (command === 'open_file_take') return [];
  return null;
});

/** Обработчики, зарегистрированные через `listen()`, по имени события. */
const listeners = new Map<string, (payload: unknown) => void>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (message: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }));
    return () => listeners.delete(event);
  },
}));

const { onIntent, readOpenedFile } = await import('../src/platform/intents');
const { EVENTS } = await import('../src/platform/ipc');

/** Дать разрешиться промисам, запущенным `onIntent()`/`readOpenedFile()`. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockClear();
  invoke.mockImplementation(async (command: string) => (command === 'open_file_take' ? [] : null));
  listeners.clear();
});

describe('событие «open-file» доводит до AppIntent', () => {
  it('путь из события становится kind: "open-file"', async () => {
    const received: unknown[] = [];
    onIntent((intent) => received.push(intent));
    await flush();

    listeners.get(EVENTS.openFile)?.('/data/inbox/incoming/Идея.md');

    expect(received).toEqual([{ kind: 'open-file', path: '/data/inbox/incoming/Идея.md' }]);
  });

  it('холодный старт: очередь, оставленная до запуска, доезжает без нажатий', async () => {
    /* «В Telegram прислали .md → поделиться» и «Открыть с помощью» умеют
       поднять приложение с нуля — путь появляется раньше, чем фронтенд
       успевает подписаться, и лежит в очереди `open_file_take()`. */
    invoke.mockImplementation(async (command: string) =>
      command === 'open_file_take' ? ['/data/inbox/incoming/Заметка.md'] : null,
    );

    const received: unknown[] = [];
    onIntent((intent) => received.push(intent));
    await flush();

    expect(received).toEqual([{ kind: 'open-file', path: '/data/inbox/incoming/Заметка.md' }]);
  });

  it('отписка останавливает и событие, и уже пришедший холодный старт не дублирует', async () => {
    const received: unknown[] = [];
    const stop = onIntent((intent) => received.push(intent));
    await flush();
    stop();

    listeners.get(EVENTS.openFile)?.('/data/inbox/incoming/Опоздавший.md');

    expect(received).toEqual([]);
  });
});

describe('readOpenedFile', () => {
  it('переводит массив чисел от Rust в Uint8Array', async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe('read_opened_file');
      expect(args).toEqual({ path: '/data/inbox/incoming/Идея.md' });
      return [35, 32, 208, 152, 208, 180, 208, 181, 209, 143];
    });

    const bytes = await readOpenedFile('/data/inbox/incoming/Идея.md');
    expect(bytes).toEqual(Uint8Array.from([35, 32, 208, 152, 208, 180, 208, 181, 209, 143]));
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('# Идея');
  });

  it('пропавший файл — null, а не исключение', async () => {
    invoke.mockImplementation(async () => null);
    expect(await readOpenedFile('/data/inbox/incoming/пропал.md')).toBeNull();
  });
});
