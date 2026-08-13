/**
 * Поиск в колонке списка (замечание про Windows).
 *
 * «В Windows очень не хватает поиска по заметкам» — и это правда было так:
 * пилюля поиска рисовалась только на телефоне, а с клавиатуры поиск
 * открывался сочетанием, которое надо было знать заранее. На широком экране
 * поиска не было видно вовсе.
 *
 * Правило: на широком экране поле поиска стоит первым в колонке списка, оно
 * настоящее (набранное сразу уходит в поиск, первые символы не теряются) и
 * подписано сочетанием — подпись здесь учит, а не украшает.
 */
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { NoteListScreen } from '../src/screens/NoteListScreen.js';
import { createTestHost } from './host.js';

async function mount(): Promise<AppController> {
  const host = createTestHost({ prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <NoteListScreen />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

describe('поиск в колонке списка', () => {
  it('на широком экране поле видно без единого нажатия', async () => {
    await mount();
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  it('набранное сразу уходит в поиск — первые символы не теряются', async () => {
    const app = await mount();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'смета' } });

    expect(app.getState().query).toBe('смета');
    expect(app.getState().route.name).toBe('search');
  });

  it('сочетание подписано у поля', async () => {
    /* Подпись — способ научить: она показывает, чем открыть поиск, не
       отрывая рук от клавиатуры. */
    await mount();
    expect(screen.getByText(/Ctrl \+ K/)).toBeTruthy();
  });
});
