/**
 * Быстрая записка: плитка, виджет и палитра доводят человека до листа, а лист —
 * до файла.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Порт `AppHost.onIntent` был объявлен в контракте и не реализован НИ С ОДНОЙ
 * стороны: событие от плитки доезжало до оболочки и упиралось в обработчик с
 * комментарием «намеренно пусто». Плитка в шторке и виджет «Записать» на
 * рабочем столе в системе выглядели рабочими и не делали ничего — человек
 * нажимал и получал просто запущенное приложение.
 *
 * Поэтому здесь проверяется стык целиком: намерение платформы → лист → файл в
 * хранилище. Проверять «метод открывает лист» бессмысленно ровно по той же
 * причине, по которой однажды пропала Справка: метод работал, дороги к нему не
 * было.
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

async function boot(options: { width?: number } = {}) {
  window.innerWidth = options.width ?? 1280;
  /* Намерение платформы подделываем портом, а не вызовом метода: именно порт и
     был не реализован. */
  let fire: ((intent: AppIntent) => void) | null = null;
  const host = createTestHost({
    files: { 'Работа/Смета.md': '# Смета\n\nплитка дороже сметы\n' },
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
  return {
    app,
    host: withIntents,
    /** Нажатие плитки в шторке или виджета на рабочем столе. */
    tap(): void {
      expect(fire, 'приложение не подписалось на намерения ОС — порт не подключён').not.toBeNull();
      (fire as unknown as (intent: AppIntent) => void)({ kind: 'new-note' });
    },
  };
}

/** Поле листа. Оно же — единственное, что лист спрашивает. */
const field = (): HTMLElement => screen.getByLabelText(ru.quickNote.fieldLabel);

describe('намерение платформы открывает лист', () => {
  it('плитка и виджет доводят до листа быстрой записки', async () => {
    const { app, tap } = await boot();
    expect(app.getState().quickNoteOpen, 'лист открыт до нажатия').toBe(false);

    tap();

    expect(await screen.findByLabelText(ru.quickNote.fieldLabel)).toBeTruthy();
    expect(app.getState().quickNoteOpen).toBe(true);
  });

  it('лист, а не пустой редактор: заметка появляется только после текста', async () => {
    /*
     * Плитку жмут на ходу. Если бы намерение сразу создавало файл, в хранилище
     * копились бы пустые заметки от каждого случайного нажатия.
     */
    const { app, tap } = await boot();
    const before = app.getState().notes.length;

    tap();
    await screen.findByLabelText(ru.quickNote.fieldLabel);

    expect(app.getState().notes.length, 'нажатие плитки само создало заметку').toBe(before);
  });
});

describe('лист доводит записку до файла', () => {
  it('текст становится заметкой, а лист закрывается', async () => {
    const { app, tap } = await boot();
    tap();
    await screen.findByLabelText(ru.quickNote.fieldLabel);

    fireEvent.change(field(), { target: { value: 'Позвонить в понедельник' } });
    fireEvent.click(screen.getByRole('button', { name: ru.quickNote.save }));

    await waitFor(() => expect(app.getState().quickNoteOpen).toBe(false));
    const created = app.getState().notes.find((note) => note.title.includes('Позвонить'));
    expect(created, 'записка не появилась в хранилище').toBeDefined();

    /*
     * Набранное — ТЕЛО заметки, а не её заголовок.
     *
     * Сначала я уводил первую строку в `#`-заголовок, и тело оставалось пустым.
     * Заказчик: «этот текст становится Заголовком (именем) записки, а не
     * внутренним текстом». Быстрая записка — мысль на ходу, а не документ с
     * названием; имя файла выводится из первой строки отдельно и в текст не
     * подставляется.
     */
    const body = (await app.readNote(created!.path))?.body ?? '';
    expect(body.trimStart().startsWith('#'), `текст уехал в заголовок: ${body}`).toBe(false);
    expect(body).toContain('Позвонить в понедельник');
    /* А в списке подпись всё равно осмысленная — из имени файла. */
    expect(created?.title).toBe('Позвонить в понедельник');
  });

  it('пустую записку сохранить нельзя', async () => {
    /* Кнопка выключена, а не «нажимается и ничего»: молчаливый отказ здесь
       читается как поломка. */
    const { tap } = await boot();
    tap();
    await screen.findByLabelText(ru.quickNote.fieldLabel);

    const save = screen.getByRole('button', { name: ru.quickNote.save });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field(), { target: { value: '   ' } });
    expect((save as HTMLButtonElement).disabled, 'пробелы сошли за текст').toBe(true);
  });

  it('папку можно выбрать, и записка ложится в неё', async () => {
    const { app, tap } = await boot();
    tap();
    await screen.findByLabelText(ru.quickNote.fieldLabel);

    /*
     * Папка выбирается ВСПЛЫВАШКОЙ, а не системным списком.
     *
     * Заказчик: «окно выбора папок — системное и выглядит очень неаккуратно и
     * не учитывает вложенность». Поэтому и проверка идёт по-человечески: нажать
     * кнопку папки, увидеть список, выбрать строку. Заодно это ловит тот отказ,
     * из-за которого однажды пропало меню панели: всплывашка внутри листа со
     * `overflow-y: auto` обрезается, если её не унести порталом.
     */
    fireEvent.click(screen.getByRole('button', { name: ru.quickNote.folderLabel }));
    const options = await screen.findByRole('listbox', { name: ru.quickNote.folderLabel });
    expect(
      [...options.querySelectorAll('[role="option"]')].map((node) => node.textContent),
      'в списке папок нет папки хранилища',
    ).toContain('Работа');

    fireEvent.click(screen.getByRole('option', { name: 'Работа' }));
    fireEvent.change(field(), { target: { value: 'Смета на плитку' } });
    fireEvent.click(screen.getByRole('button', { name: ru.quickNote.save }));

    await waitFor(() => expect(app.getState().quickNoteOpen).toBe(false));
    const created = app.getState().notes.find((note) => note.title.includes('Смета на плитку'));
    expect(created?.path.startsWith('Работа/'), `записка легла не в папку: ${created?.path}`).toBe(
      true,
    );
  });

  it('кнопки голоса нет, пока нет голосового ввода', async () => {
    /*
     * Прямое указание заказчика: «кнопку предусмотреть, но не показывать».
     * Правило проекта то же (BEHAVIOR §5.1): возможности нет — элемент скрыт, а
     * не показан выключенным. Кнопка, которая ничего не делает, обещает то,
     * чего в продукте нет.
     */
    const { tap } = await boot();
    tap();
    await screen.findByLabelText(ru.quickNote.fieldLabel);

    expect(screen.queryByRole('button', { name: ru.quickNote.voice })).toBeNull();
  });
});
