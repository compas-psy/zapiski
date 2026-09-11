/**
 * Раздел «Безопасность» закрыт и подписан «СКОРО».
 *
 * ── Решение заказчика ───────────────────────────────────────────────────────
 *
 * «Раздел Безопасность сделай неактивным и подписью СКОРО» — продолжение более
 * раннего: «шифрование — тяжёлая функция, давай её из MVP вырежем; продумаем
 * позже и сделаем с современной биометрией и/или Яндекс Ключом».
 *
 * ── Что здесь стережётся ────────────────────────────────────────────────────
 *
 * Три вещи, и каждая once уже ломалась в этом продукте по-своему:
 *
 *  1. пункт ВИДЕН и подписан — иначе человек, однажды его видевший, решит, что
 *     настройки урезали молча;
 *  2. пункт не нажимается — кнопка, которая на вид нажимается и ничего не
 *     делает, хуже отсутствующей;
 *  3. прямой адрес `section=security` отвечает СЛОВАМИ — ссылка могла остаться
 *     в закладке, и пустой экран по ней был бы тупиком. Ровно этим тупиком
 *     заказчик уже упирался в другом месте продукта.
 *
 * Проверяется предложение, а не код: `SecuritySection` со всеми тумблерами на
 * месте и вернётся одной строкой (`SECURITY_SETTINGS_ENABLED`).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { SECURITY_SETTINGS_ENABLED } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

async function mount(section: 'appearance' | 'security'): Promise<void> {
  const host = createTestHost({ files: {}, prefs: { onboarded: true } });
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
}

function securityNavItem(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('.za-settings__nav-item')].find((item) =>
    (item.textContent ?? '').includes(ru.settings.sections.security),
  );
}

describe('«Безопасность» — закрытый раздел', () => {
  it('пункт остаётся в навигации', async () => {
    await mount('appearance');
    expect(securityNavItem(), 'пункт «Безопасность» исчез из настроек').toBeTruthy();
  });

  it('пункт подписан «СКОРО» и не нажимается', async () => {
    await mount('appearance');
    const item = securityNavItem();
    expect(item?.textContent, 'подписи «СКОРО» у пункта нет').toContain(ru.settings.security.soon);
    /* `disabled`, а не вид disabled: с клавиатуры такой пункт не берёт фокус и
       не притворяется нажимаемым. */
    expect(item?.disabled, 'закрытый раздел нажимается').toBe(!SECURITY_SETTINGS_ENABLED);
  });

  it('прямой адрес раздела объясняет, а не молчит', async () => {
    await mount('security');
    expect(
      screen.queryByText(ru.settings.security.soonNote),
      'по адресу закрытого раздела пусто — ссылка из закладки ведёт в тупик',
    ).toBeTruthy();
  });

  it('органов управления шифрованием в закрытом разделе нет', async () => {
    await mount('security');
    /* Смысл закрытия: настроек шифрования здесь не показывают. Само шифрование
       при этом работает — оно включается из меню заметки, и об этом сказано
       в тексте раздела. */
    expect(
      screen.queryByText(ru.settings.security.encryptDefault),
      'тумблер шифрования виден в закрытом разделе',
    ).toBe(null);
    expect(
      screen.queryByText(ru.settings.security.changePassword),
      'кнопка смены пароля видна в закрытом разделе',
    ).toBe(null);
  });
});
