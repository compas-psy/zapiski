/**
 * Служебные папки вложений в интерфейсе.
 *
 * ── Что сказал заказчик ─────────────────────────────────────────────────────
 *
 * «Самое интересное, что файлы по факту в папках есть, но они не отображаются
 * приложением. Кроме того, так как это "системные" папки — они должны быть
 * серыми и в настройках и должно быть можно скрыть».
 *
 * Три требования, три группы проверок ниже. Первая — про потерю доверия:
 * человек видит вложение в заметке, открывает папку `Images` и видит пустоту.
 * Вывод у него один — файлы не сохранились, — и он неверный.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { LibraryPanel } from '../src/screens/LibraryPanel.js';
import { NoteListScreen } from '../src/screens/NoteListScreen.js';
import { InfoPanel } from '../src/screens/InfoPanel.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

type Host = ReturnType<typeof createTestHost>;

/** Хранилище с заметкой и настоящими файлами вложений в служебных папках. */
async function boot(): Promise<{ app: AppController; host: Host }> {
  const host = createTestHost({
    files: { 'Идеи.md': '# Идеи\n\n![](<Images/2026-08-14_кот.png>)\n' },
    prefs: { onboarded: true },
  });
  await host.storage.write('Images/2026-08-14_кот.png', PNG);
  await host.storage.write('Audio/2026-08-14_сессия.m4a', new Uint8Array(2048));
  await host.storage.write('Other files/смета.docx', new Uint8Array(64));
  const app = new AppController(host);
  await app.boot();
  await app.vaultRef?.rebuild();
  await app.refresh();
  return { app, host };
}

function mount(app: AppController, node: React.ReactNode): void {
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          {node}
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('файлы в папке вложений видно', () => {
  it('открытая папка Images показывает файл, а не пустоту', async () => {
    const { app } = await boot();
    app.openFolder('Images');
    mount(app, <NoteListScreen />);

    await waitFor(() => {
      expect(
        screen.getByText('2026-08-14_кот.png'),
        'папка с файлом выглядит пустой — ровно то, на что жаловался заказчик',
      ).toBeTruthy();
    });
    app.dispose();
  });

  it('в папке видно размер файла — по имени с датой и хешем его не узнать', async () => {
    const { app } = await boot();
    app.openFolder('Other files');
    mount(app, <NoteListScreen />);

    await waitFor(() => expect(screen.getByText('смета.docx')).toBeTruthy());
    expect(screen.getByText(/64/)).toBeTruthy();
    app.dispose();
  });

  it('пустая папка вложений говорит про файлы, а не про заметки', async () => {
    const { app, host } = await boot();
    /* Звук лежит в `Audio`, а `Images` очищаем — сравнивать надо с пустой. */
    await host.storage.remove('Images/2026-08-14_кот.png');
    app.openFolder('Images');
    mount(app, <NoteListScreen />);

    await waitFor(() => expect(screen.getByText(ru.attachments.emptyFolder)).toBeTruthy());
    /* Кнопки «Новая заметка» здесь нет: заметка среди картинок мешает и там,
       и в списке. */
    expect(screen.queryByText(ru.list.newNote)).toBeNull();
    app.dispose();
  });
});

describe('служебная папка выглядит служебной', () => {
  it('в дереве она приглушена, а папка человека — нет', async () => {
    const { app } = await boot();
    await app.createFolder('', 'Практика');
    mount(app, <LibraryPanel />);

    const images = await screen.findByText('Images');
    const own = await screen.findByText('Практика');
    expect(
      images.closest('.z-tree__item')?.className,
      'служебная папка неотличима от папки человека',
    ).toContain('z-tree__item--muted');
    expect(own.closest('.z-tree__item')?.className).not.toContain('z-tree__item--muted');
    app.dispose();
  });

  it('настройка прячет служебные папки и не трогает свои', async () => {
    const { app } = await boot();
    await app.createFolder('', 'Практика');
    mount(app, <LibraryPanel />);
    await screen.findByText('Images');

    await app.setAttachmentFoldersShown(false);

    await waitFor(() => expect(screen.queryByText('Images')).toBeNull());
    expect(screen.queryByText('Audio')).toBeNull();
    expect(screen.getByText('Практика'), 'спрятали заодно и папку человека').toBeTruthy();
    app.dispose();
  });

  it('спрятанная папка ничего не удаляет: файлы на месте', async () => {
    const { app } = await boot();
    await app.setAttachmentFoldersShown(false);

    const files = await app.vaultRef?.attachmentsIn('Images');
    expect(files?.map((file) => file.name)).toEqual(['2026-08-14_кот.png']);
    app.dispose();
  });

  it('в настройках сказано, куда попадают файлы, — три папки, а не старая attachments', async () => {
    const { app } = await boot();
    /* Строка под выбором «Общая в корне» печатала `attachments` — путь, по
       которому вложений давно нет: человек шёл искать файлы не туда. */
    expect(app.attachmentPathHint()).toBe(ru.attachments.sharedHint);
    expect(app.attachmentPathHint()).toContain('Images');
    app.dispose();
  });
});

describe('панель «Инфо» показывает вложения заметки', () => {
  it('видит файлы в новых папках и путь в угловых скобках', async () => {
    const { app } = await boot();
    const note = await app.vaultRef?.read('Идеи.md');
    expect(note, 'заметка не прочиталась').toBeTruthy();

    mount(
      app,
      <InfoPanel
        note={{
          ...note!,
          body: '![](<Images/2026-08-14_кот.png>)\n\n[](<Other files/смета.docx>)\n\n[Другая](Другая.md)\n',
        }}
        backlinks={[]}
      />,
    );

    /* Регулярка знала только `attachments/…` и не понимала угловых скобок,
       поэтому у заметки с картинкой и документом вложений «не было». */
    expect(await screen.findByText('Images/2026-08-14_кот.png')).toBeTruthy();
    expect(screen.getByText('Other files/смета.docx')).toBeTruthy();
    /* Ссылка на другую заметку — не вложение: для неё есть обратные ссылки. */
    expect(screen.queryByText('Другая.md')).toBeNull();
    app.dispose();
  });
});
