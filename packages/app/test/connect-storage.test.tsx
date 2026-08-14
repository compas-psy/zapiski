/**
 * Подключение места хранения: сказано заранее, показано по факту.
 *
 * ── Вопрос заказчика ────────────────────────────────────────────────────────
 *
 * «Сидел пользователь на локальной папке в приложении и накопил кучу записок.
 * Решил подключить облако: что происходит с этими файлами? Должно быть
 * проработанное, стандартное и предсказуемое для пользователя решение, при
 * котором данные он не должен потерять».
 *
 * Механика «ничего не теряется» живёт в ядре и проверена там
 * (`packages/core/test/sync-switch`). Здесь — предсказуемость, и она делается
 * двумя вещами:
 *
 *  1. подсказка НАД выбором отвечает на вопрос до нажатия;
 *  2. после первого обмена приходит тост с числами — сколько уехало, сколько
 *     приехало, сколько раз сохранены обе версии.
 *
 * Модалки с подтверждением здесь нет намеренно: их в продукте ровно три, и все
 * три про необратимое (инвариант 8). Подключение места обратимо — необратимо
 * молчание о его последствиях.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

async function openSync(files: Record<string, string> = {}): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <SettingsScreen section="sync" />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

describe('что будет с накопленным — сказано до выбора', () => {
  it('подсказка над выбором отвечает на все три вопроса сразу', async () => {
    const app = await openSync({ 'Идеи.md': '# Идеи\n\nпервая\n' });
    const hint = ru.settings.sync.whereHint;

    await waitFor(() => expect(screen.getByText(hint)).toBeTruthy());
    /* Куда уедет своё, откуда приедет чужое и что будет при совпадении имён —
       человек спрашивает ровно это и ровно в этот момент. */
    expect(hint).toContain('накопленное уедет туда');
    expect(hint).toContain('приедет сюда');
    expect(hint).toContain('Ничего не удаляется');
    expect(hint).toContain('сохранятся обе версии');
    app.dispose();
  });
});

describe('итог первого обмена приходит числами', () => {
  it('после подключения места показывается, сколько уехало и приехало', async () => {
    const app = await openSync({ 'Идеи.md': '# Идеи\n\nпервая\n' });

    /* Подключаем настоящий бэкенд — пустую папку: одна заметка обязана
       уехать, и об этом обязано быть сказано. */
    const { LocalFolderBackend, MemoryVaultStorage } = await import('@zapiski/core');
    await app.switchBackend(new LocalFolderBackend(new MemoryVaultStorage(), { origin: 'проверка' }));

    await waitFor(() => {
      const summary = ru.settings.sync.firstSyncSummary(1, 0, 0);
      expect(screen.getByText(summary)).toBeTruthy();
    });
    app.dispose();
  });

  it('обычная синхронизация числами не отчитывается', async () => {
    /* Тост на каждый оборот синка — шум: он идёт каждые несколько секунд.
       Числа нужны один раз, при смене места. */
    const app = await openSync({ 'Идеи.md': '# Идеи\n\nпервая\n' });
    const { LocalFolderBackend, MemoryVaultStorage } = await import('@zapiski/core');
    await app.switchBackend(new LocalFolderBackend(new MemoryVaultStorage(), { origin: 'проверка' }));
    await waitFor(() => expect(screen.getByText(ru.settings.sync.firstSyncSummary(1, 0, 0))).toBeTruthy());

    await app.syncNow();
    /* Второй раз тех же чисел быть не должно: тост один, а не два. */
    await waitFor(() =>
      expect(screen.queryAllByText(ru.settings.sync.firstSyncSummary(0, 0, 0))).toHaveLength(0),
    );
    app.dispose();
  });
});
