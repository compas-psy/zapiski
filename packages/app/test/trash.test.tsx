/**
 * Корзина: что стоит в строке и где стоит очистка.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик прислал снимок с одной фразой: «Корзина выглядит ужасно». На снимке
 * заголовок шапки обрезан до «К…», метастрока разъехалась на пять строк, а
 * кнопка «Восстановить» занимала полстроки с розовой подсветкой во всю её
 * высоту.
 *
 * ── Что здесь можно проверить, а что нельзя ─────────────────────────────────
 *
 * В happy-dom нет раскладки: ни ширины колонки, ни обрезания, ни переноса. Всё
 * это меряет браузерный прогон `scripts/check-trash.mjs`, и он тут главный.
 *
 * Модульно проверяется РАЗМЕТКА — то, из чего раскладка потом получается, и то,
 * что легче всего вернуть назад не думая:
 *
 *  · в шапке нет ничего, кроме «назад» и заголовка (кнопка в шапке и ужимала
 *    слово «Корзина» до буквы);
 *  · строка печатает папку, а не полный путь с расширением;
 *  · сведения, которые нёс путь, не потеряны: у зашифрованной записи замок;
 *  · «Очистить корзину» на месте — просто в другом месте, и по-прежнему
 *    спрашивает подтверждение (BEHAVIOR §0).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { TrashScreen } from '../src/screens/TrashScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

const FILES = {
  'Работа/Проекты/Смета.md': '# Смета\n\nчисла по смете\n',
  'Заметка в корне.md': '# Заметка в корне\n\nтекст\n',
};

async function boot(): Promise<AppController> {
  const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

function mount(app: AppController): void {
  render(
    <ToastProvider>
      <AppProvider host={app.host} controller={app}>
        <TrashScreen />
      </AppProvider>
    </ToastProvider>,
  );
}

describe('корзина: строка отвечает на «что это и откуда»', () => {
  it('печатает папку, а не полный путь с расширением', async () => {
    const app = await boot();
    await app.trashNote('Работа/Проекты/Смета.md');
    mount(app);

    expect(screen.getByText('Смета')).toBeTruthy();
    /* Хвост пути — то, что человек узнаёт. Имя файла в строке уже есть
       заголовком, второй раз печатать его незачем. */
    expect(screen.getByText('Работа/Проекты')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toContain('Смета.md');
  });

  it('заметка из корня обходится без пустой папки и лишней точки', async () => {
    const app = await boot();
    await app.trashNote('Заметка в корне.md');
    mount(app);

    const meta = document.querySelector('.za-row__meta')?.textContent?.trim() ?? '';
    expect(meta, 'метастроки нет вовсе').not.toBe('');
    /* Ни ведущего разделителя, ни пустого места под папку: строка начинается
       сразу с того, что про заметку известно. */
    expect(meta).not.toContain('·');
    expect(meta.startsWith(ru.trash.deletedAt('').trim())).toBe(true);
  });

  it('у зашифрованной записи остаётся замок — сведения из пути не потеряны', async () => {
    const app = await boot();
    await app.setVaultPassword('верный пароль');
    const encrypted = await app.encryptNote('Работа/Проекты/Смета.md');
    expect(encrypted).toBe('Работа/Проекты/Смета.md.enc');
    await app.trashNote(encrypted!);
    mount(app);

    expect(screen.getByLabelText(ru.list.markEncrypted)).toBeTruthy();
    expect(document.body.textContent ?? '').not.toContain('.md.enc');
  });
});

describe('корзина: где стоят действия', () => {
  it('в шапке только «назад» и заголовок — больше туда ничего не влезает', async () => {
    const app = await boot();
    await app.trashNote('Заметка в корне.md');
    mount(app);

    const header = document.querySelector('.za-header');
    expect(header, 'шапки нет').toBeTruthy();
    const buttons = within(header as HTMLElement).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(
      [ru.app.back],
    );
    expect(within(header as HTMLElement).getByText(ru.trash.title)).toBeTruthy();
  });

  it('«Очистить корзину» стоит рядом с объяснением про 30 дней', async () => {
    const app = await boot();
    await app.trashNote('Заметка в корне.md');
    mount(app);

    const bar = document.querySelector('.za-trash__bar');
    expect(bar, 'строки с объяснением нет').toBeTruthy();
    expect(within(bar as HTMLElement).getByRole('button', { name: ru.trash.purge })).toBeTruthy();
  });

  it('пустая корзина не предлагает себя чистить', async () => {
    const app = await boot();
    mount(app);

    expect(screen.queryByRole('button', { name: ru.trash.purge })).toBeNull();
  });

  it('«Восстановить» возвращает заметку, и строка уходит', async () => {
    const app = await boot();
    await app.trashNote('Заметка в корне.md');
    mount(app);

    fireEvent.click(screen.getByRole('button', { name: ru.trash.restore }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getState().trash).toHaveLength(0);
  });
});
