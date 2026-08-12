/**
 * Как вложение ведёт себя в тексте (ITERATION-1 §5, «Как выглядит в тексте»).
 *
 * §5 обещает три разных поведения: картинка открывается полноэкранно и
 * закрывается свайпом вниз, файл открывается системным приложением, у карточки
 * виден размер. Ничего из этого не было: тап по превью просто ставил курсор,
 * а документ оставался голой ссылкой.
 *
 * Проверяется путь целиком — от нажатия в редакторе до слоя просмотра и до
 * вызова оболочки, — потому что ломалось здесь именно звено между пакетами:
 * редактор звал колбэк, которого приложение не передавало.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { NoteScreen } from '../src/screens/NoteScreen.js';
import { AttachmentUrls } from '../src/lib/attachment-urls.js';
import { createTestHost } from './host.js';

/** PNG размером 1×1 — настоящие байты, а не заглушка. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

type Host = ReturnType<typeof createTestHost>;

/** Заметка с вложением: файл кладётся в хранилище настоящими байтами. */
async function mountNote(
  body: string,
  attachment: { path: string; bytes: Uint8Array },
): Promise<Host> {
  const host = createTestHost({
    files: { 'Заметка.md': `# Заметка\n\n${body}\n` },
    prefs: { onboarded: true },
  });
  await host.storage.write(attachment.path, attachment.bytes);
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <NoteScreen path="Заметка.md" />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  await screen.findByRole('textbox', { name: 'Название заметки' });
  return host;
}

describe('картинка открывается полноэкранно', () => {
  it('тап по превью поднимает просмотр', async () => {
    await mountNote('![кот](attachments/кот.png)', {
      path: 'attachments/кот.png',
      bytes: PNG,
    });

    /* Превью появляется не сразу: первый `resolveAttachment` возвращает
       `null` и запускает чтение, а картинку показывает уже перерисовка. */
    const image = await waitFor(() => {
      const found = document.querySelector('.cm-z-image');
      expect(found, 'превью картинки не нарисовано').not.toBeNull();
      return found as Element;
    });

    fireEvent.mouseDown(image);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('Esc закрывает', async () => {
    await mountNote('![кот](attachments/кот.png)', {
      path: 'attachments/кот.png',
      bytes: PNG,
    });
    const image = await waitFor(() => {
      const found = document.querySelector('.cm-z-image');
      expect(found).not.toBeNull();
      return found as Element;
    });
    fireEvent.mouseDown(image);
    const viewer = await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(viewer.isConnected).toBe(false));
  });

  it('свайп вниз закрывает, а короткий — возвращает картинку на место', async () => {
    /* Порог нужен именно потому, что слой ловит нажатие целиком: без него
       просмотр закрывался бы от касания, которым его только что открыли. */
    await mountNote('![кот](attachments/кот.png)', {
      path: 'attachments/кот.png',
      bytes: PNG,
    });
    const image = await waitFor(() => {
      const found = document.querySelector('.cm-z-image');
      expect(found).not.toBeNull();
      return found as Element;
    });
    fireEvent.mouseDown(image);
    const viewer = await screen.findByRole('dialog');

    fireEvent.pointerDown(viewer, { clientY: 100 });
    fireEvent.pointerMove(viewer, { clientY: 140 });
    fireEvent.pointerUp(viewer, { clientY: 140 });
    expect(viewer.isConnected, 'короткий свайп закрыл просмотр').toBe(true);

    fireEvent.pointerDown(viewer, { clientY: 100 });
    fireEvent.pointerMove(viewer, { clientY: 400 });
    fireEvent.pointerUp(viewer, { clientY: 400 });
    await waitFor(() => expect(viewer.isConnected).toBe(false));
  });
});

describe('файл открывается системным приложением', () => {
  it('тап по карточке зовёт оболочку, а не просмотр', async () => {
    const host = await mountNote('[](attachments/договор.pdf)', {
      path: 'attachments/договор.pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    const opened = vi.fn(async (_url: string) => {});
    host.openExternal = opened;

    const card = await waitFor(() => {
      const found = document.querySelector('.cm-z-file');
      expect(found, 'карточка файла не нарисована').not.toBeNull();
      return found as Element;
    });
    fireEvent.mouseDown(card);

    expect(opened).toHaveBeenCalledTimes(1);
    /* Открывать нужно URL, а не путь в хранилище: в вебе это OPFS, на Android
       — SAF, и системному приложению такой путь ничего не говорит. */
    expect(String(opened.mock.calls[0]?.[0] ?? '')).not.toBe('attachments/договор.pdf');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('на карточке виден размер файла', async () => {
    await mountNote('[](attachments/договор.pdf)', {
      path: 'attachments/договор.pdf',
      bytes: new Uint8Array(4096),
    });
    await waitFor(() => {
      expect(document.querySelector('.cm-z-file__size')?.textContent).toBe('4 КБ');
    });
  });
});

describe('кэш вложений помнит объём', () => {
  it('до чтения размера нет, после чтения он равен числу байтов', async () => {
    const host = createTestHost();
    await host.storage.write('attachments/файл.bin', new Uint8Array(2048));

    let ready = 0;
    const urls = new AttachmentUrls(() => {
      ready += 1;
    });
    urls.attach(host.storage);

    /* Первый запрос честно отвечает «пока нечего показать» и запускает
       чтение — размер в этот момент тоже неизвестен. */
    expect(urls.resolve('attachments/файл.bin')).toBeNull();
    expect(urls.size('attachments/файл.bin')).toBeNull();

    await waitFor(() => expect(ready).toBe(1));
    expect(urls.size('attachments/файл.bin')).toBe(2048);

    urls.clear();
    expect(urls.size('attachments/файл.bin')).toBeNull();
  });
});
