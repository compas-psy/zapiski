/**
 * Два согласия на экране входа.
 *
 * Заказчик: «Я хочу, чтобы пользователи хотя бы авторизовались/регистрировались
 * даже для бесплатной работы. Зачем: мне нужно собирать согласия на рекламу
 * (отдельное согласие, непреднажатое и необязательное) и обработку ПДн
 * (пользовательское соглашение)».
 *
 * Согласие, собранное неправильно, хуже несобранного: оно не имеет силы, а
 * рассылка по нему — нарушение. Поэтому здесь проверяется не «галочки есть», а
 * то, что делает их согласием: обе сняты изначально, обязательное держит
 * кнопку, добровольное ни на что не влияет и уезжает отдельным полем.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LEGAL_URLS } from '@zapiski/core';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SignInScreen } from '../src/screens/SignInScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

async function mount(): Promise<AppController> {
  const host = createTestHost({ files: {}, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <SignInScreen />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

/** Галочка по её подписи. */
function box(label: string): HTMLInputElement {
  const found = screen.getByText(label, { exact: false }).closest('label');
  const input = found?.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`галочки «${label}» нет`);
  return input as HTMLInputElement;
}

describe('согласия на экране входа', () => {
  it('галочки у соглашения нет вовсе: договор принимается действием', () => {
    /*
     * Пакет CMPAS §3.3 и §5: центральное соглашение принимается однозначным
     * действием — нажатием кнопки входа, — а рядом с кнопкой сказано, что
     * именно принимается, и дана ссылка. Обязательная галочка «ради
     * юридического UX» пакетом прямо не требуется, а та, что здесь стояла,
     * нарушала ещё и §3.2: одним флажком принимались СРАЗУ соглашение и
     * политика.
     */
    expect(Object.keys(ru.signIn)).not.toContain('consentTerms');
    expect(ru.signIn.consentByAction.length).toBeGreaterThan(0);
  });

  it('на экране одна галочка — рекламная, и она снята', async () => {
    await mount();
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
    expect(boxes, 'галочек больше одной — соглашение снова просят флажком').toHaveLength(1);
    expect((boxes[0] as HTMLInputElement).checked, 'рекламное преднажато').toBe(false);
  });

  it('политика не принимается: рядом с ней нет ни одного флажка', async () => {
    await mount();
    const privacy = [...document.querySelectorAll('a')].find(
      (node) => node.getAttribute('href') === LEGAL_URLS.privacy,
    );
    expect(privacy, 'ссылки на политику нет вовсе').toBeTruthy();
    expect(
      privacy?.closest('label')?.querySelector('input[type="checkbox"]'),
      'политику снова принимают галочкой — она документ информационный',
    ).toBeFalsy();
  });

  it('войти можно сразу: ничего не держит кнопки', async () => {
    await mount();
    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });

    const send = screen.getByRole('button', { name: ru.signIn.sendLink });
    expect((send as HTMLButtonElement).disabled).toBe(false);

    const yandex = screen.queryByRole('button', { name: ru.signIn.yandex });
    if (yandex) expect((yandex as HTMLButtonElement).disabled).toBe(false);
  });

  it('рекламное согласие уезжает отдельным полем, а не в нагрузку', async () => {
    const app = await mount();
    const sent = vi.spyOn(app, 'sendMagicLink').mockResolvedValue(true);

    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });
    fireEvent.click(screen.getByRole('button', { name: ru.signIn.sendLink }));

    expect(sent).toHaveBeenCalledWith('marina@ya.ru', { marketing: false });
    app.dispose();
  });

  it('поставленное рекламное согласие доезжает как `true`', async () => {
    const app = await mount();
    const sent = vi.spyOn(app, 'sendMagicLink').mockResolvedValue(true);

    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });
    fireEvent.click(box(ru.signIn.consentMarketing));
    fireEvent.click(screen.getByRole('button', { name: ru.signIn.sendLink }));

    expect(sent).toHaveBeenCalledWith('marina@ya.ru', { marketing: true });
    app.dispose();
  });

  it('документы даны ссылками ДО нажатия: согласие вслепую — не согласие', async () => {
    await mount();
    const links = [...document.querySelectorAll('a')].map((node) => node.getAttribute('href'));
    expect(links).toContain(LEGAL_URLS.terms);
    expect(links).toContain(LEGAL_URLS.privacy);
  });
});

/*
 * Проверка «на сервер уезжает та же редакция, что показана человеку» живёт в
 * `auth.test.ts`: там уже есть стенд с подменённым `fetch`, и повторять его
 * здесь значило бы держать две копии одного и того же.
 */
