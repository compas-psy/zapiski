/**
 * Онбординг обязан ПРЕДЛОЖИТЬ выбор папки там, где он есть.
 *
 * Отзыв заказчика про Android: «Самый главный косяк — не выбирается папка,
 * где хранить заметки». Кнопка на шаге 2 была, нажатие срабатывало, а
 * системного диалога человек не видел никогда: на Android
 * `pickVaultDirectory` по устройству отдаёт каталог приложения, а настоящий
 * выбор живёт в отдельном порте `vaultFolders` — за него там платят
 * атомарностью записи, и приложение говорит об этой цене вслух.
 *
 * Порт был, экран настроек его звал — но до настроек на телефоне нельзя было
 * добраться (затемнение библиотеки перехватывало нажатия), и единственная
 * дорога к выбору папки оказалась перекрыта с обеих сторон.
 *
 * Правило: если платформа объявила системный выбор, онбординг обязан его
 * показать, а не назначать место за человека.
 *
 * Правило действует В ОБОЛОЧКАХ. В браузере всё наоборот: папки у сайта нет,
 * а системный диалог на Android после выбора не отвечал — экран замирал на
 * «Дальше» насовсем. Это отдельная проверка, `web-onboarding.test.tsx`.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@zapiski/ui';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { OnboardingScreen } from '../src/screens/OnboardingScreen.js';
import { createTestHost } from './host.js';

describe('шаг 2: выбор места для заметок', () => {
  it('платформа умеет выбирать папку — диалог показывается', async () => {
    const chooseFolder = vi.fn(async () => null);
    const base = createTestHost();
    /* Так выглядит Android: системный выбор — в `vaultFolders`, а
       `pickVaultDirectory` молча отдаёт каталог приложения. Порт объявлен
       только для чтения, поэтому платформа собирается заново, а не правится
       на месте. */
    const host = {
      ...base,
      platform: {
        ...base.platform,
        /* Именно Android, а не веб: в браузере папку не спрашивают вовсе —
           у сайта её нет, и системный диалог там кончался зависанием
           (`web-onboarding.test.tsx`). Прежде тестовый хост объявлял себя
           вебом, и правило проверялось не на той платформе. */
        kind: 'android' as const,
        vaultFolders: { chooseFolder, useAppFolder: async () => null, current: async () => null },
      },
    };

    const app = new AppController(host);
    render(
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <OnboardingScreen step={2} />
        </AppProvider>
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Дальше|Выбрать папку/ }));

    await waitFor(() => {
      expect(
        chooseFolder,
        'онбординг не предложил системный выбор папки — место назначено за человека',
      ).toHaveBeenCalled();
    });
  });

  it('платформы без своего выбора работают как прежде', async () => {
    /* Обратная сторона: на Windows порта `vaultFolders` нет, а
       `pickVaultDirectory` и так открывает нативный диалог. Ветка обязана
       остаться прежней — иначе сторож выше можно было бы удовлетворить,
       сломав десктоп. */
    const base = createTestHost();
    const pick = vi.fn(async () => null);
    const host = {
      ...base,
      platform: {
        ...base.platform,
        kind: 'windows' as const,
        vaultFolders: undefined,
        pickVaultDirectory: pick,
      },
    };

    const app = new AppController(host);
    render(
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <OnboardingScreen step={2} />
        </AppProvider>
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Дальше|Выбрать папку/ }));

    await waitFor(() => expect(pick).toHaveBeenCalled());
  });
});
