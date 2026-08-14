/**
 * Заметка из Obsidian показывает своё название.
 *
 * ── Что сказал заказчик ─────────────────────────────────────────────────────
 *
 * «Заметки .md, перенесённые из Obsidian, не подхватывают название файла в
 * виде заголовка заметки».
 *
 * ── Почему так выходило ─────────────────────────────────────────────────────
 *
 * В Obsidian имя заметки — это имя файла, а строка `# Заголовок` в тексте не
 * обязательна. Список у нас давно берёт имя файла третьим источником имени, а
 * поле названия в открытой заметке — только текст. Получалось, что в списке
 * заметка называется «Идеи по практике», а внутри поле пустое: приложение
 * противоречило само себе.
 *
 * Вторая половина проверки важнее первой: показать имя мало, нельзя при этом
 * ТРОГАТЬ чужой файл. Простое открытие заметки не должно дописывать в неё
 * строку `# …` — архив принесли к нам целиком, и он обязан остаться таким,
 * каким его принесли, пока человек сам не решит иначе.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { NoteScreen } from '../src/screens/NoteScreen.js';
import { createTestHost } from './host.js';

afterEach(cleanup);

const FROM_OBSIDIAN = 'Первая мысль без заголовка.\n\nВторая строка.\n';

type Host = ReturnType<typeof createTestHost>;

async function boot(): Promise<{ app: AppController; host: Host }> {
  const host = createTestHost({
    files: { 'Идеи по практике.md': FROM_OBSIDIAN },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  await app.refresh();
  return { app, host };
}

function mount(app: AppController, path: string): void {
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          <NoteScreen path={path} />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('название заметки без строки «#»', () => {
  it('поле показывает имя файла, как и список', async () => {
    const { app } = await boot();
    mount(app, 'Идеи по практике.md');

    await waitFor(() => {
      const field = screen.getByLabelText(/Название заметки|Note title/i) as HTMLInputElement;
      expect(field.value, 'поле названия пустое, хотя в списке имя есть').toBe('Идеи по практике');
    });
    app.dispose();
  });

  it('открытие не дописывает «# Заголовок» в чужой файл', async () => {
    const { app, host } = await boot();
    mount(app, 'Идеи по практике.md');

    await waitFor(() => expect(screen.getByLabelText(/Название заметки|Note title/i)).toBeTruthy());
    /* Даём автосохранению отработать: оно живёт на таймере 500 мс. */
    await new Promise((resolve) => setTimeout(resolve, 900));

    const bytes = await host.storage.read('Идеи по практике.md');
    const text = new TextDecoder().decode(bytes as Uint8Array);
    expect(text, 'чужой файл переписан от одного лишь открытия').toBe(FROM_OBSIDIAN);
    app.dispose();
  });

  it('правка названия — уже решение человека: заголовок появляется в файле', async () => {
    const { app, host } = await boot();
    mount(app, 'Идеи по практике.md');

    await screen.findByLabelText(/Название заметки|Note title/i);
    /* Экран за время загрузки успевает пересобраться (скелетон → готовый
       экран), и первая же найденная ссылка на поле оказывается на выброшенном
       узле: события в него уходят в никуда. Берём поле заново — так же, как
       это делает человек, который до него дотрагивается. */
    await waitFor(() => {
      const node = screen.getByLabelText(/Название заметки|Note title/i);
      expect(node.isConnected).toBe(true);
    });
    const field = screen.getByLabelText(/Название заметки|Note title/i);
    fireEvent.change(field, { target: { value: 'Практика' } });

    /* Проверяем ТЕКСТ, а не имя файла: переименование по заголовку живёт на
       своей отложенной дорожке (BEHAVIOR §2.2) и покрыто отдельно. Здесь
       важно другое — заголовок появился в файле, потому что так решил
       человек, а не потому что заметку открыли. */
    await waitFor(
      async () => {
        const bytes =
          (await host.storage.read('Идеи по практике.md')) ??
          (await host.storage.read('Практика.md'));
        expect(bytes, 'заметка исчезла из хранилища').toBeTruthy();
        expect(new TextDecoder().decode(bytes as Uint8Array)).toContain('# Практика');
      },
      { timeout: 4000 },
    );
    app.dispose();
  });
});
