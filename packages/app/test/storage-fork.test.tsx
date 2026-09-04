/**
 * Одна развилка вместо двух разделов (отзыв второго круга).
 *
 * Заказчик: «Сейчас там непонятный UX — отдельные настройки синхронизации
 * (WebDav и Облако) и отдельно есть пункт про Хранилище. Такое разнесение
 * фрустрирует, так как непонятно, могу я хранить всё в папке и одновременно в
 * WebDav/Облаке. По факту, это должны быть взаимоисключающие вещи, но с
 * бережностью при переключении из одного режима в другой: данные не должны
 * потеряться».
 *
 * Взаимоисключающими они и были — движок синхронизации ровно один. Не хватало
 * двух вещей, и обе проверяются здесь: чтобы это было ВИДНО (один список с
 * отметкой «сейчас», а не два независимых раздела) и чтобы переключение
 * ничего не обрывало.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  LocalFolderBackend,
  MemoryVaultStorage,
  OWN_STORAGE_ENABLED,
  type SyncBackend,
} from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

async function mount(section: 'sync' | 'storage' = 'sync'): Promise<AppController> {
  const host = createTestHost({
    files: { 'Заметка.md': '# Заметка\n' },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <SettingsScreen section={section} />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

describe('место хранения — один список', () => {
  it('в навигации нет отдельного «Хранилища»', async () => {
    await mount();
    const nav = document.querySelectorAll('.za-settings__nav-item');
    const names = [...nav].map((item) => item.textContent);
    expect(names, 'разделов снова два').toContain(ru.settings.sections.sync);
    expect(names).not.toContain('Хранилище');
  });

  it('старый адрес «Хранилища» ведёт в тот же раздел, а не в пустоту', async () => {
    await mount('storage');
    /* Ссылки и вызовы `navigate({section: "storage"})` живут в коде и в
       памяти людей — молча приводить их на пустой экран нельзя. */
    expect(screen.getByText(ru.settings.sync.backends)).toBeTruthy();
  });

  it('режимы взаимоисключающие: отмечен ровно один', async () => {
    await mount();
    const modes = screen.getAllByRole('radio');
    expect(modes.length, 'списка режимов нет').toBeGreaterThan(1);
    const chosen = modes.filter((node) => node.getAttribute('aria-checked') === 'true');
    expect(chosen, 'отмечено не одно место хранения').toHaveLength(1);
    /* По умолчанию — только на этом устройстве: синхронизации нет. */
    expect(chosen[0]?.textContent).toContain(ru.settings.sync.modeLocalOnly);
  });

  /**
   * Решение заказчика: «пока в настройках скрой Яндекс.Диск и WebDav — они по
   * сути конкуренты облаку, за которое мы просим оплату».
   *
   * Проверяется предложение, а не код backend'ов: сами они на месте и вернутся
   * одной строкой (`OWN_STORAGE_ENABLED`).
   */
  it('чужие хранилища не предлагаются, пока выключены', async () => {
    await mount();
    /* Ищем поля подключения, а не слова: «WebDAV» и «Яндекс.Диск» встречаются
       в подсказках соседних карточек («копия в папке клиента Яндекс.Диска»),
       и проверка по тексту поймала бы их, а не саму карточку. */
    expect(screen.queryByLabelText(ru.settings.sync.webdavUrl) !== null).toBe(
      OWN_STORAGE_ENABLED,
    );
    expect(screen.queryByLabelText(ru.settings.sync.yandexToken) !== null).toBe(
      OWN_STORAGE_ENABLED,
    );
    /*
     * Локальный режим при этом на месте: прячем конкурента, а не выбор.
     *
     * Облако Записок к этому решению отношения не имеет и живёт по своему,
     * независимому правилу (`cloudAvailable`, `cloud-gate.test.tsx`): его
     * карточка показывается всегда, а недоступность платформы называется
     * словами внутри неё. Этот тест по-прежнему про судьбу Яндекс.Диска и
     * WebDAV — поэтому облако здесь только упоминается, а не проверяется.
     */
    const titles = screen.getAllByRole('radio').map((node) => node.textContent ?? '');
    expect(titles.some((text) => text.includes(ru.settings.sync.modeLocalOnly))).toBe(true);
  });

  it('выбор другого режима снимает прежний', async () => {
    const app = await mount();
    const storage = new MemoryVaultStorage({ files: {} });
    await app.switchBackend(new LocalFolderBackend(storage, { title: 'Флешка' }));

    const chosen = screen
      .getAllByRole('radio')
      .filter((node) => node.getAttribute('aria-checked') === 'true');
    expect(chosen, 'после выбора отмечено не одно место').toHaveLength(1);
    expect(app.getState().backendId).toBe('local');
    app.dispose();
  });
});

describe('переключение бережное', () => {
  it('перед уходом с хранилища досылается несохранённое', async () => {
    const app = await mount();
    const storage = new MemoryVaultStorage({ files: {} });
    await app.switchBackend(new LocalFolderBackend(storage, { title: 'Флешка' }));

    /* Автосинк идёт с задержкой 5 с после правки. Переключение в эту секунду
       обрывало последнюю правку: на диске она есть, а до второго устройства
       не доехала — и человек об этом не знал. */
    const flushed = vi.spyOn(app, 'syncNow');
    await app.switchBackend(null);

    expect(flushed, 'ушли с хранилища, не досылая').toHaveBeenCalled();
    expect(app.getState().backendId).toBeNull();
    app.dispose();
  });

  it('недоступная сеть переключению не мешает', async () => {
    const app = await mount();
    const storage = new MemoryVaultStorage({ files: {} });
    await app.switchBackend(new LocalFolderBackend(storage, { title: 'Флешка' }));

    vi.spyOn(app, 'syncNow').mockRejectedValue(new Error('нет сети'));
    /* Заметки всегда лежат локально, и невозможность досылки — не повод
       запереть человека в прежнем режиме. */
    await app.switchBackend(null);
    expect(app.getState().backendId).toBeNull();
    app.dispose();
  });

  it('прежний бэкенд не остаётся вторым', async () => {
    const app = await mount();
    const first = new LocalFolderBackend(new MemoryVaultStorage({ files: {} }), { title: 'Одна' });
    const second: SyncBackend = new LocalFolderBackend(new MemoryVaultStorage({ files: {} }), {
      title: 'Другая',
    });
    await app.switchBackend(first);
    await app.switchBackend(second);
    expect(app.getState().backendId).toBe('local');
    app.dispose();
  });
});
