/**
 * Скопированное в папку дерево видно без перезапуска.
 *
 * Заказчик: «Если в корневую папку Записок просто скопировать дерево папок и
 * файлов из хранилища Obsidian, то они… если приложение ЗАПИСКИ открыто, то
 * добавленные папки отображаются сразу, а файлы только после перезагрузки
 * приложения».
 *
 * Расхождение объяснялось одной строкой в `refresh()`: папки берутся с диска
 * (`vault.folders()`), а заметки — из индекса в памяти (`vault.notes()`).
 * Индекс собирается один раз, при открытии хранилища, — то есть при запуске
 * приложения. Отсюда и «файлы только после перезагрузки».
 */
import { render } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

async function booted(): Promise<ReturnType<typeof createTestHost> & { app: AppController }> {
  const host = createTestHost({
    files: { 'Своя.md': '# Своя\n\nтекст\n' },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  return Object.assign(host, { app });
}

describe('папку пересматриваем, а не помним', () => {
  it('файл, положенный мимо приложения, появляется после пересмотра', async () => {
    const { app, storage } = await booted();
    expect(app.getState().notes.map((note) => note.path)).toEqual(['Своя.md']);

    /* Так это и происходит: файл кладёт файловый менеджер, а не мы. */
    await storage.write('Из Obsidian.md', new TextEncoder().encode('заметка без заголовка\n'));

    /* Пока не пересмотрели — список прежний, и это не ошибка: следить за
       папкой постоянно нам нечем. */
    expect(app.getState().notes).toHaveLength(1);

    expect(await app.rescanVault(), 'пересмотр не заметил нового файла').toBe(true);
    const paths = app.getState().notes.map((note) => note.path);
    expect(paths).toContain('Из Obsidian.md');
    /* И название взято из имени файла — иначе список показал бы «Без названия». */
    expect(app.getState().notes.find((note) => note.path === 'Из Obsidian.md')?.title).toBe(
      'Из Obsidian',
    );
    app.dispose();
  });

  it('удалённый мимо приложения файл тоже уходит из списка', async () => {
    const { app, storage } = await booted();
    await storage.remove('Своя.md');
    expect(await app.rescanVault()).toBe(true);
    expect(app.getState().notes).toHaveLength(0);
    app.dispose();
  });

  it('ничего не изменилось — индекс не пересобирается', async () => {
    /* Пересмотр зовётся на каждое возвращение к приложению, а полная
       пересборка читает КАЖДЫЙ файл. Делать её впустую нельзя. */
    const { app } = await booted();
    expect(await app.rescanVault()).toBe(false);
    app.dispose();
  });

  it('возвращение к приложению пересматривает папку само', async () => {
    const host = createTestHost({
      files: { 'Своя.md': '# Своя\n' },
      prefs: { onboarded: true },
    });
    const app = new AppController(host);
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <div />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );
    await act(async () => {
      await app.boot();
    });

    await host.storage.write('Пришло.md', new TextEncoder().encode('текст\n'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      app.getState().notes.map((note) => note.path),
      'вернулись в приложение, а список остался прежним',
    ).toContain('Пришло.md');
    app.dispose();
  });
});
