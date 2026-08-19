/**
 * «Поделиться» — только там, где системное окно есть.
 *
 * Заказчик: «только в android сделай вверху справа в уместном месте кнопку
 * поделиться, которая вызывает системное окно поделиться. При шаринге в
 * Telegram рассчитываю, что с новой функцией работы с markdown форматирование
 * там не будет ломаться».
 *
 * ── Что здесь было написано раньше и оказалось неправдой ────────────────────
 *
 * «Наружу уходит markdown КАК ЕСТЬ… разбирать разметку — работа принимающей
 * стороны; стоит нам „подготовить“ текст, и в Telegram приедет каша». Тест это
 * и проверял: сверял отправленное с исходником заметки — то есть с самим
 * собой, а не с тем, что получатель умеет прочитать.
 *
 * Заказчик прислал снимок из Telegram: `# Психологов развелось!`,
 * `**Слишком много выбора.**` звёздочками, `> цитата` палкой, `![|258](…)` и
 * `[имя](адрес)` скобками. Каша приехала именно от «как есть».
 *
 * Отсюда требования, которые проверяются ниже: кнопка есть на Android и её нет
 * в вебе и на Windows (скрытый элемент честнее выключенного — BEHAVIOR §5.1),
 * а наружу уходит текст, переведённый в разметку получателя, — и ни одного
 * маркера, которого он не понимает.
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

const NOTE =
  '# Планы\n\n**жирный** пункт\n\n> цитата\n\n![|258](Images/a.png)\n\n- первый\n- второй\n\n[Мой сайт](https://ilyamartynov.ru)\n';

type Shared = { title?: string; text: string };

async function boot(options: { android: boolean; accepts?: boolean; markdown?: boolean }): Promise<{
  app: AppController;
  shared: Shared[];
}> {
  const host = createTestHost({
    files: { 'Планы.md': NOTE },
    /* Настройка приходит из сохранённых — так она и живёт: человек выбрал
       режим однажды, а отправляет потом. */
    prefs: { onboarded: true, ...(options.markdown === false ? { 'share.markdown': false } : {}) },
  });
  const shared: Shared[] = [];
  if (options.android) {
    (host.platform as { kind: string }).kind = 'android';
    (host.platform as unknown as { shareOut: unknown }).shareOut = {
      text: vi.fn(async (payload: Shared) => {
        shared.push(payload);
        return options.accepts === false
          ? { kind: 'failed' as const, reason: 'ActivityNotFoundException' }
          : { kind: 'shared' as const };
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
  it('на Android отдаёт системе текст, который получатель прочитает', async () => {
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
    /* Заголовок — жирной строкой: `#` мессенджеру ничего не говорит. */
    expect(payload.text).toContain('**Планы**');
    /* Жирный совпадает по синтаксису и остаётся собой. */
    expect(payload.text).toContain('**жирный**');
    /* Список — точкой: дефис у получателя списком не станет. */
    expect(payload.text).toContain('• первый');
    /* Ссылка — адресом, его мессенджер подсветит сам. */
    expect(payload.text).toContain('Мой сайт — https://ilyamartynov.ru');
    /* И ни одного маркера, который получатель покажет сырым. */
    for (const junk of ['# Планы', '> цитата', '- первый', '![', '](', '|258']) {
      expect(payload.text, `«${junk}» уедет человеку в глаза`).not.toContain(junk);
    }
    app.dispose();
  });

  /**
   * Второй режим настройки — на случай получателя, который не разбирает даже
   * то, что обязан. Именно это заказчик и увидел: на снимке из Telegram
   * `**Слишком много выбора.**` приехало звёздочками.
   */
  it('«простым текстом» отправляет заметку без единого маркера', async () => {
    const { app, shared } = await boot({ android: true, markdown: false });
    expect(app.shareFlavour(), 'сохранённый выбор не дожил до отправки').toBe('plain');

    await screen.findByRole('button', { name: ru.note.share });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: ru.note.share }).isConnected).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: ru.note.share }));

    await waitFor(() => expect(shared).toHaveLength(1));
    const payload = shared[0] as Shared;
    expect(payload.text).toContain('Планы');
    expect(payload.text).toContain('жирный пункт');
    /* Структуру держат символы, а не разметка: она видна и без разбора. */
    expect(payload.text).toContain('• первый');
    expect(payload.text).toMatch(/^│ цитата$/m);
    for (const marker of ['**', '__', '~~', '#', '>', '](']) {
      expect(payload.text, `«${marker}» человеку читать не нужно`).not.toContain(marker);
    }
    app.dispose();
  });

  it('окна не случилось, но текст в буфере — говорим именно это', async () => {
    const host = createTestHost({ files: { 'Планы.md': NOTE }, prefs: { onboarded: true } });
    (host.platform as { kind: string }).kind = 'android';
    (host.platform as unknown as { shareOut: unknown }).shareOut = {
      text: async () => ({ kind: 'copied' as const }),
    };
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

    await screen.findByRole('button', { name: ru.note.share });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: ru.note.share }).isConnected).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: ru.note.share }));

    await waitFor(() => expect(screen.getByText(ru.note.shareCopied)).toBeTruthy());
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

  it('отказ показывает причину системы, а не нашу догадку', async () => {
    const { app, shared } = await boot({ android: true, accepts: false });

    await screen.findByRole('button', { name: ru.note.share });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: ru.note.share }).isConnected).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: ru.note.share }));

    await waitFor(() => expect(shared).toHaveLength(1));
    /* Настоящая причина, а не «ни одно приложение не принимает текст»: именно
       такой уверенный и ложный тост увидел заказчик на телефоне, где
       приложений полно. */
    await waitFor(() =>
      expect(screen.getByText(ru.note.shareFailed('ActivityNotFoundException'))).toBeTruthy(),
    );
    app.dispose();
  });
});
