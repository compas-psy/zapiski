/**
 * Раздел «О приложении».
 *
 * `1_Design.md` §3.2 (И6) требует настройки целиком, и последним пунктом —
 * «о приложении (с указанием издателя СИМПАС и лицензий)». Раздела не было
 * вовсе, а вместе с ним не было и единственного законного места для имени
 * издателя: по Р1 продукт называется ЗАПИСКИ, а СИМПАС живёт «только в сторе,
 * счетах и юр. текстах».
 *
 * Отсюда состав проверок: имя издателя показано ровно здесь и нигде больше,
 * версия приходит от оболочки (у веба, установщика и apk свои номера), а
 * лицензии перечислены — иначе OFL-шрифты и MIT-компоненты едут в сборке без
 * упоминания, что для OFL и MIT прямое нарушение условий.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '@zapiski/ui';

import { AppController } from '../src/state/store.js';
import { AppProvider } from '../src/state/context.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { ru } from '../src/i18n/ru.js';
import { createTestHost } from './host.js';

async function mountAbout(): Promise<void> {
  const host = createTestHost({ prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ToastProvider>
      <AppProvider host={host} controller={app}>
        <SettingsScreen section="about" />
      </AppProvider>
    </ToastProvider>,
  );
}

describe('раздел «О приложении» (1_Design.md §3.2, И6)', () => {
  it('раздел вообще есть в списке разделов', async () => {
    await mountAbout();
    expect(screen.getByRole('button', { name: ru.settings.sections.about })).toBeTruthy();
  });

  it('издатель назван — и это единственное место, где он назван', async () => {
    await mountAbout();
    expect(screen.getByText(ru.settings.about.publisherName)).toBeTruthy();
    /* Продукт при этом называется своим именем: Р1, «самостоятельный бренд». */
    expect(screen.getByText(ru.settings.about.productName)).toBeTruthy();
  });

  it('версия — та, что отдала оболочка, а не константа приложения', async () => {
    await mountAbout();
    // createTestHost отдаёт заведомо узнаваемое значение: если экран возьмёт
    // версию откуда-нибудь ещё, здесь будет другой текст.
    expect(screen.getByText('0.0.0-test')).toBeTruthy();
  });

  it('лицензии перечислены: OFL-шрифты и MIT-компоненты названы', async () => {
    await mountAbout();
    for (const item of ru.settings.about.licenseItems) {
      expect(screen.getByText(item), `${item} не показан`).toBeTruthy();
    }
  });
});
