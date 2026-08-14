/**
 * «Поделиться» — только там, где системное окно есть.
 *
 * Заказчик: «только в android сделай вверху справа в уместном месте кнопку
 * поделиться, которая вызывает системное окно поделиться. При шаринге в
 * Telegram рассчитываю, что с новой функцией работы с markdown форматирование
 * там не будет ломаться».
 *
 * Отсюда три требования, и все три проверяются ниже: кнопка есть на Android,
 * её нет в вебе и на Windows (скрытый элемент честнее выключенного —
 * BEHAVIOR §5.1), а наружу уходит markdown КАК ЕСТЬ — с `# Заголовком`,
 * звёздочками и списками. Разбирать разметку — работа принимающей стороны;
 * стоит нам «подготовить» текст, и в Telegram приедет каша.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { NoteScreen } from '../src/screens/NoteScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

const NOTE = '# Планы\n\n**жирный** пункт\n\n- первый\n- второй\n';

type Shared = { title?: string; text: string };

async function boot(options: { android: boolean; accepts?: boolean }): Promise<{
  app: AppController;
  shared: Shared[];
}> {
  const host = createTestHost({ files: { 'Планы.md': NOTE }, prefs: { onboarded: true } });
  const shared: Shared[] = [];
  if (options.android) {
    (host.platform as { kind: string }).kind = 'android';
    (host.platform as unknown as { shareOut: unknown }).shareOut = {
      text: vi.fn(async (payload: Shared) => {
        shared.push(payload);
        return options.accepts ?? true;
      }),
    };
  }
  const app = new AppController(host);
  await app.boot();
  await app.refresh();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={app.host} controller={app}>
          <NoteScreen path="Планы.md" />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return { app, shared };
}

describe('кнопка «Поделиться»', () => {
  it('на Android отдаёт системе markdown как есть', async () => {
    const { app, shared } = await boot({ android: true });

    await screen.findByRole('button', { name: ru.note.share });
    /* Экран за время загрузки пересобирается (скелетон → готовый экран), и
       первая найденная ссылка указывает на выброшенный узел: клик в него
       уходит в никуда. Берём кнопку заново — как человек, который до неё
       дотрагивается. */
    await waitFor(() =>
      expect(screen.getByRole('button', { name: ru.note.share }).isConnected).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: ru.note.share }));

    await waitFor(() => expect(shared).toHaveLength(1));
    const payload = shared[0] as Shared;
    expect(payload.title, 'у письма нет темы — почта покажет пустую строку').toBe('Планы');
    /* Разметка уходит нетронутой: заголовок строкой `# …`, звёздочки, дефисы. */
    expect(payload.text).toContain('# Планы');
    expect(payload.text).toContain('**жирный**');
    expect(payload.text).toContain('- первый');
    app.dispose();
  });

  it('в вебе кнопки нет вовсе — системного окна там не существует', async () => {
    const { app } = await boot({ android: false });
    await screen.findByLabelText(/Название заметки/i);
    expect(
      screen.queryByRole('button', { name: ru.note.share }),
      'кнопка обещает системное окно там, где его нет',
    ).toBeNull();
    app.dispose();
  });

  it('если принять текст некому — говорит словами, а не молчит', async () => {
    const { app, shared } = await boot({ android: true, accepts: false });

    await screen.findByRole('button', { name: ru.note.share });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: ru.note.share }).isConnected).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: ru.note.share }));

    await waitFor(() => expect(shared).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(ru.note.shareFailed)).toBeTruthy());
    app.dispose();
  });
});
