/**
 * Экран обращения и контекстная полоса — то, до чего человек доходит руками.
 *
 * ── Почему этого теста мало не бывает ───────────────────────────────────────
 *
 * Уровнем ниже уже сторожится главное: из тела запроса не уходит содержимого
 * заметок (`feedback.test.ts`), а правило «раз в сутки, после отказа неделя»
 * проверено в ядре (`feedback.prompt.test.ts`). Оба теста зелены при экране,
 * до которого нельзя дойти, и при кнопке, которая ничего не отправляет: ровно
 * так уже было со Справкой — экран написан, покрыт тестом и никуда не
 * подключён.
 *
 * Поэтому здесь проверяется стык: нажатия человека → тело запроса.
 *
 *  1. Пустая форма не отправляется и говорит об этом.
 *  2. Заполненная — отправляется, и в теле нет ни строчки из заметок.
 *  3. Скриншот по умолчанию не приложен (это блокирующее требование).
 *  4. Без сети форма не отказывает, а обещает дослать.
 *  5. Полоса появляется после сбоя, ведёт в форму и после «Не сейчас»
 *     не возвращается.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { AppProvider } from '../src/state/context.js';
import { AppShell } from '../src/App.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

/** Хранилище, какое бывает у человека: по нему и проверяется утечка. */
const NOTES: Record<string, string> = {
  'Работа/Переговоры с Ольгой.md': '# Переговоры с Ольгой\n\nусловия аренды, отложить до пятницы\n',
  'Личное/Дневник.md': '# Дневник\n\nтяжело после переезда\n',
};

/** Отличительные строки хранилища — те, что в посторонней речи не встречаются. */
function forbiddenStrings(): string[] {
  const out = new Set<string>();
  for (const [path, body] of Object.entries(NOTES)) {
    out.add(path);
    for (const segment of path.split('/')) out.add(segment.replace(/\.md$/, ''));
    const words = body.split(/[\s#\n,.]+/).filter((word) => word.length >= 5);
    for (const word of words) if (/^[А-ЯЁ]/.test(word)) out.add(word);
  }
  return [...out].filter((value) => value.length >= 5);
}

async function boot(options: { online?: boolean; prefs?: Record<string, unknown> } = {}) {
  window.innerWidth = 1280;
  const sent: string[] = [];
  let accept = options.online ?? true;
  /* Платформа — настольная, а не веб: в вебе стоит стена входа (аккаунт
     обязателен, иначе заметки на разных устройствах выглядят потерянными), и
     до каркаса дело не доходит вовсе. Обратная связь же обязана работать БЕЗ
     аккаунта — это её отдельное требование, и проверять её через стену входа
     значит проверять стену. */
  const host = createTestHost({
    files: NOTES,
    platform: { kind: 'windows' },
    prefs: { onboarded: true, ...options.prefs },
  });
  const app = new AppController(host, undefined, undefined, {
    feedbackFetch: async (_url, init) => {
      if (!accept) throw new Error('сети нет');
      sent.push(String(init?.body ?? ''));
      return { ok: true, status: 202 } as Response;
    },
  });
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
  /* Загрузка договаривает своё уже после `boot()`: открытие хранилища
     заканчивается `route: list`, и переход, сделанный раньше этого момента,
     молча стирается. Ждём готовности — иначе тест проверял бы гонку. */
  await waitFor(() => expect(app.getState().ready).toBe(true));
  return { app, host, sent };
}

/** Заполнить форму и нажать «Отправить». */
async function fill(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(ru.feedback.textLabel), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: ru.feedback.submit }));
}

describe('форма обращения', () => {
  it('пустая не уезжает и говорит об этом', async () => {
    const { app, sent } = await boot();
    app.openFeedback('menu');

    await screen.findByRole('button', { name: ru.feedback.submit });
    fireEvent.click(screen.getByRole('button', { name: ru.feedback.submit }));

    expect(await screen.findByText(ru.feedback.textRequired)).toBeTruthy();
    expect(sent, 'пустое обращение уехало на сервер').toHaveLength(0);
  });

  it('заполненная уезжает, и в теле нет ни строчки из заметок', async () => {
    const { app, sent } = await boot();
    expect(app.getState().notes.length, 'хранилище пустое — сторожу нечего ловить').toBe(2);
    app.openFeedback('menu');

    await screen.findByRole('button', { name: ru.feedback.submit });
    await fill('После смены папки список остался пустым');

    await waitFor(() => expect(sent).toHaveLength(1));
    for (const forbidden of forbiddenStrings()) {
      expect(sent[0], `в обращении нашлось содержимое заметок: ${forbidden}`).not.toContain(
        forbidden,
      );
    }
    /* И сам рассказ доехал — иначе «чисто» означало бы «пусто». */
    expect(sent[0]).toContain('После смены папки');
  });

  it('скриншот по умолчанию не приложен', async () => {
    /*
     * Блокирующее требование. Снимок экрана — единственное место формы, где
     * утечка возможна физически: на нём видно открытую заметку. Поэтому он
     * прикладывается только явным действием, а «по умолчанию» здесь значит
     * «поля нет в теле вовсе», а не «поле пустое».
     */
    const { app, sent } = await boot();
    app.openFeedback('menu');
    await screen.findByRole('button', { name: ru.feedback.submit });

    /* Сам тумблер выключен — это и есть «по умолчанию». Проверять только
       пустое тело мало: тело было бы пустым и при включённом тумблере, пока
       снимок не выбран, и сторож проспал бы перевод умолчания. */
    const toggle = screen.getByRole('switch', { name: ru.feedback.screenshotLabel });
    expect((toggle as HTMLInputElement).checked, 'снимок предлагается сам собой').toBe(false);
    /* И предупреждение стоит рядом, а не появляется после включения. */
    expect(screen.getByText(ru.feedback.screenshotWarning)).toBeTruthy();

    await fill('Не открывается вложение');

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(Object.keys(JSON.parse(sent[0] as string))).not.toContain('screenshot');
  });

  it('без сети форма не отказывает, а обещает дослать', async () => {
    const { app, sent } = await boot({ online: false });
    app.openFeedback('menu');

    await screen.findByRole('button', { name: ru.feedback.submit });
    await fill('Синхронизация висит третий день');

    expect(await screen.findByText(ru.feedback.queuedTitle)).toBeTruthy();
    expect(sent, 'без сети что-то всё-таки ушло').toHaveLength(0);
    expect(await app.pendingFeedback(), 'обращение не легло в очередь').toBe(1);
  });
});

describe('дорога к форме', () => {
  it('в библиотеке есть постоянный вход — не только в настройках', async () => {
    /*
     * Требование альфа-тестирования: путь в три касания сквозь настройки
     * означает, что напишут единицы. Человек, у которого что-то не получилось,
     * закрывает приложение, а не идёт искать раздел «О приложении».
     *
     * Сторож проверяет именно НАЖАТИЕ, а не наличие метода: `openFeedback`
     * работал и до этой кнопки, а дойти до него человек не мог.
     */
    const { app } = await boot();

    const entry = await screen.findByRole('button', { name: ru.feedback.open });
    fireEvent.click(entry);

    expect(await screen.findByRole('button', { name: ru.feedback.submit })).toBeTruthy();
    expect(app.getState().route.name).toBe('feedback');
  });
});

describe('контекстная полоса', () => {
  it('появляется после сбоя и ведёт в форму', async () => {
    const { app } = await boot();

    expect(await app.offerFeedback('error', { errorCode: 'SYNC_FAILED' })).toBe(true);
    expect(await screen.findByText(ru.feedback.prompt.error)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: ru.feedback.prompt.action }));

    expect(await screen.findByRole('button', { name: ru.feedback.submit })).toBeTruthy();
    expect(app.getState().route.name).toBe('feedback');
    /* Повод доехал до формы: без него обращение «что-то сломалось» бесполезно. */
    const route = app.getState().route;
    expect(route.name === 'feedback' ? route.context?.errorCode : null).toBe('SYNC_FAILED');
  });

  it('текст полосы зависит от повода', async () => {
    const { app } = await boot();
    /* «Что-то пошло не так» после конфликта заметок было бы неправдой: там
       ничего не сломалось, там разошлось. */
    expect(await app.offerFeedback('sync_conflict', { conflict: 'both-kept' })).toBe(true);
    expect(await screen.findByText(ru.feedback.prompt.sync_conflict)).toBeTruthy();
  });

  it('«Не сейчас» закрывает её и не возвращает назавтра', async () => {
    const { app } = await boot();
    await app.offerFeedback('error', { errorCode: 'SYNC_FAILED' });
    await screen.findByText(ru.feedback.prompt.error);

    fireEvent.click(screen.getByRole('button', { name: ru.feedback.prompt.dismiss }));

    await waitFor(() => expect(screen.queryByText(ru.feedback.prompt.error)).toBeNull());
    /* И следующий сбой молчит: отказ — это ответ, а не пауза. */
    expect(await app.offerFeedback('error', { errorCode: 'SYNC_FAILED' })).toBe(false);
  });

  it('второй сбой подряд не показывает вторую полосу', async () => {
    const { app } = await boot();
    expect(await app.offerFeedback('error', { errorCode: 'SYNC_FAILED' })).toBe(true);
    expect(await app.offerFeedback('slow_op', { durationMs: 20_000 })).toBe(false);
    expect(screen.queryByText(ru.feedback.prompt.slow_op)).toBeNull();
  });
});
