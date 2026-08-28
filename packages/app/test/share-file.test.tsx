/**
 * Приём `.md`-файла через системное «Поделиться» на Android (например, из
 * Telegram) — тот же `ShareSheet`, что и для текста, ссылки и картинки, но с
 * новым `payload.kind === 'file'` (BEHAVIOR §8, ТЗ §5.4).
 *
 * ── Почему не через `vaultRef.create()` ──────────────────────────────────
 *
 * Файл, пришедший извне, — это ИМПОРТ, а не текст для вставки: у него уже
 * есть имя, и правило BEHAVIOR §9 «импорт никогда не перезаписывает
 * существующую заметку» обязано действовать и здесь так же, как при броске
 * мышью и при ассоциации `.md` на Windows (`open-file.test.tsx`). Отдельная
 * дорога через `vaultRef.create()` этого правила не знает.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SharedPayload } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { AppProvider } from '../src/state/context.js';
import { AppShell } from '../src/App.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

async function boot(options: { files?: Record<string, string> } = {}) {
  window.innerWidth = 1280;
  let deliver: ((payload: SharedPayload) => void) | null = null;
  const host = createTestHost({
    files: options.files ?? { 'Работа/Смета.md': '# Смета\n' },
    platform: {
      kind: 'android',
      shareTarget: {
        onShare(handler) {
          deliver = handler;
          return () => {
            deliver = null;
          };
        },
      },
    },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <AppShell />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  await waitFor(() => expect(app.getState().ready).toBe(true));

  return {
    app,
    /** Система («Поделиться» из Telegram и подобных) передала `.md`-файл. */
    shareFile(name: string, text: string): void {
      expect(deliver, 'приложение не подписалось на ShareTargetProvider — порт не подключён')
        .not.toBeNull();
      (deliver as unknown as (payload: SharedPayload) => void)({
        kind: 'file',
        name,
        bytes: new TextEncoder().encode(text),
      });
    },
  };
}

describe('«Поделиться» файлом .md на Android', () => {
  it('превью показывает имя файла, а не содержимое', async () => {
    const { shareFile } = await boot();
    shareFile('Идея.md', '# Идея\n\nдовольно длинный текст записки\n');

    const sheet = await screen.findByRole('dialog', { name: ru.share.title });
    expect(sheet.textContent).toContain('Идея.md');
    expect(sheet.textContent).not.toContain('довольно длинный текст записки');
  });

  it('«Добавить» кладёт файл тем же импортом, что и ассоциация, и открывается тостом', async () => {
    const { app, shareFile } = await boot();
    shareFile('Идея.md', '# Идея\n\nтекст записки\n');

    await screen.findByRole('dialog', { name: ru.share.title });
    fireEvent.click(screen.getByRole('button', { name: ru.share.add }));

    await waitFor(() => {
      const created = app.getState().notes.find((note) => note.path === 'Идея.md');
      expect(created, 'заметка не появилась в хранилище').toBeDefined();
    });
    const note = await app.readNote('Идея.md');
    expect(note?.body).toContain('текст записки');

    /* Тост со ссылкой «Открыть» — как и у любого другого источника share. */
    expect(await screen.findByText(ru.share.added('Идея'))).toBeTruthy();
  });

  it('папку можно выбрать так же, как для текста', async () => {
    const { app, shareFile } = await boot();
    shareFile('Идея.md', 'текст');

    await screen.findByRole('dialog', { name: ru.share.title });
    fireEvent.change(screen.getByLabelText(ru.share.folder), { target: { value: 'Работа' } });
    fireEvent.click(screen.getByRole('button', { name: ru.share.add }));

    await waitFor(() => {
      const created = app.getState().notes.find((note) => note.path === 'Работа/Идея.md');
      expect(created, 'заметка не легла в выбранную папку').toBeDefined();
    });
  });

  it('одноимённая заметка не перезаписывается — суффикс, как при импорте', async () => {
    const { app, shareFile } = await boot({ files: { 'Идея.md': '# Идея\n\nстарый текст\n' } });
    shareFile('Идея.md', 'новый текст из шеринга');

    await screen.findByRole('dialog', { name: ru.share.title });
    fireEvent.click(screen.getByRole('button', { name: ru.share.add }));

    await waitFor(() => {
      expect(app.getState().notes.some((note) => note.path !== 'Идея.md' && note.path.includes('Идея'))).toBe(
        true,
      );
    });
    const original = await app.readNote('Идея.md');
    expect(original?.body, 'старая заметка затёрлась').toContain('старый текст');
  });
});
