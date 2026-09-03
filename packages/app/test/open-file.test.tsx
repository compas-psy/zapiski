/**
 * Файл ассоциации `.md`: Windows «Открыть с помощью» и Android «Открыть
 * с помощью» / «Поделиться» (ТЗ §5.4, BEHAVIOR §8).
 *
 * ── Что проверяется и почему именно так ──────────────────────────────────
 *
 * Порт `AppHost.onIntent` уже был проверен на стыке для `new-note`
 * (`quick-note.test.tsx`) — здесь та же дисциплина для `open-file`: намерение
 * платформы → чтение байт оболочкой → диалог выбора папки → заметка в
 * хранилище → открытая заметка. Проверять «метод создаёт заметку» само по
 * себе бессмысленно ровно по той же причине, по которой однажды пропала
 * Справка: метод работал, дороги к нему не было.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import type { AppIntent } from '../src/contract.js';
import { AppProvider } from '../src/state/context.js';
import { AppShell } from '../src/App.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

async function boot(options: { files?: Record<string, string> } = {}) {
  window.innerWidth = 1280;
  /* Намерение платформы подделываем портом, а не вызовом метода: именно порт
     и был не реализован (`quick-note.test.tsx` — та же дисциплина). */
  let fire: ((intent: AppIntent) => void) | null = null;
  const readBytes = new Map<string, Uint8Array>();
  const host = createTestHost({
    files: options.files ?? { 'Работа/Смета.md': '# Смета\n' },
    platform: { kind: 'windows' },
    prefs: { onboarded: true },
  });
  const withIntents = Object.assign(host, {
    onIntent(handler: (intent: AppIntent) => void) {
      fire = handler;
      return () => {
        fire = null;
      };
    },
    async readOpenedFile(path: string): Promise<Uint8Array | null> {
      return readBytes.get(path) ?? null;
    },
  });
  const app = new AppController(withIntents);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={withIntents} controller={app}>
          <AppShell />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  await waitFor(() => expect(app.getState().ready).toBe(true));

  const send = (intent: AppIntent): void => {
    expect(fire, 'приложение не подписалось на намерения ОС — порт не подключён').not.toBeNull();
    (fire as unknown as (intent: AppIntent) => void)(intent);
  };

  return {
    app,
    host: withIntents,
    /** ОС попросила открыть файл с этим путём и содержимым. */
    openFile(path: string, bytes: Uint8Array): void {
      readBytes.set(path, bytes);
      send({ kind: 'open-file', path });
    },
    /** ОС попросила открыть файл, которого оболочка прочитать не смогла. */
    openMissingFile(path: string): void {
      send({ kind: 'open-file', path });
    },
  };
}

describe('намерение «open-file» доводит до диалога выбора папки', () => {
  it('диалог открывается с именем файла в заголовке', async () => {
    const { openFile } = await boot();
    openFile('C:\\Users\\a\\Идея.md', new TextEncoder().encode('# Идея\n\nтекст\n'));

    expect(
      await screen.findByRole('dialog', { name: ru.library.openFileFolderTitle('Идея.md') }),
    ).toBeTruthy();
  });

  it('выбор папки создаёт заметку тем же импортом, что и бросок мышью, и открывает её', async () => {
    const { app, openFile } = await boot();
    openFile('/tmp/Идея.md', new TextEncoder().encode('# Идея\n\nтекст\n'));

    await screen.findByRole('dialog', { name: ru.library.openFileFolderTitle('Идея.md') });
    fireEvent.click(screen.getByRole('treeitem', { name: 'Работа' }));

    await waitFor(() => {
      const created = app.getState().notes.find((note) => note.path === 'Работа/Идея.md');
      expect(created, 'заметка не появилась в выбранной папке').toBeDefined();
    });
    await waitFor(() => expect(app.getState().route).toEqual({ name: 'note', id: 'Работа/Идея.md' }));
  });

  it('корень предлагается, даже когда у объекта нет текущего места', async () => {
    /*
     * `FolderPickerDialog` прячет «В корень», когда объект уже там
     * (`current === ''`) — для входящего файла места нет вовсе, и корень
     * обязан оставаться выбором, иначе на пустом хранилище без единой папки
     * выбрать было бы нечего.
     */
    const { app, openFile } = await boot({ files: {} });
    openFile('/tmp/Заметка.md', new TextEncoder().encode('текст'));

    await screen.findByRole('dialog', { name: ru.library.openFileFolderTitle('Заметка.md') });
    fireEvent.click(screen.getByRole('button', { name: ru.library.moveToRoot }));

    await waitFor(() => {
      const created = app.getState().notes.find((note) => note.path === 'Заметка.md');
      expect(created, 'заметка не легла в корень').toBeDefined();
    });
  });

  it('отмена ничего не создаёт', async () => {
    const { app, openFile } = await boot();
    openFile('/tmp/Идея.md', new TextEncoder().encode('# Идея\n'));

    await screen.findByRole('dialog', { name: ru.library.openFileFolderTitle('Идея.md') });
    const before = app.getState().notes.length;
    fireEvent.click(screen.getByRole('button', { name: ru.app.cancel }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app.getState().notes.length, 'отмена всё равно создала заметку').toBe(before);
  });

  it('пропавший файл — тост, а не тихая пустота', async () => {
    /*
     * Между запуском ассоциации и чтением файл могли переместить или
     * удалить: `readOpenedFile` тогда отвечает `null` (см. `platform.rs`,
     * «пропавший файл не ошибка»). Молчаливого исчезновения быть не должно —
     * человек нажал «Открыть с помощью», а получить обязан объяснение, а не
     * диалог выбора папки для файла, которого больше нет.
     */
    const { app, openMissingFile } = await boot();
    const toasts: string[] = [];
    app.setToastSink((toast) => toasts.push(toast.message));

    openMissingFile('/tmp/пропал.md');

    await waitFor(() => expect(toasts).toContain(ru.library.openFileUnavailable));
    expect(screen.queryByRole('dialog'), 'диалог папки открылся для пропавшего файла').toBeNull();
  });
});
