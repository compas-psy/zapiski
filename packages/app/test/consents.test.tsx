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
  it('обе галочки сняты: преднажатая галочка согласием не является', async () => {
    await mount();
    expect(box(ru.signIn.consentTerms).checked, 'обязательное преднажато').toBe(false);
    expect(box(ru.signIn.consentMarketing).checked, 'рекламное преднажато').toBe(false);
  });

  it('без обязательного согласия войти нельзя ни одним способом', async () => {
    await mount();
    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });

    const send = screen.getByRole('button', { name: ru.signIn.sendLink });
    expect((send as HTMLButtonElement).disabled, 'письмо ушло бы без согласия').toBe(true);

    const yandex = screen.queryByRole('button', { name: ru.signIn.yandex });
    if (yandex) {
      expect((yandex as HTMLButtonElement).disabled, 'вход Яндексом без согласия').toBe(true);
    }
  });

  it('обязательного согласия достаточно: рекламное ничего не держит', async () => {
    await mount();
    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });
    fireEvent.click(box(ru.signIn.consentTerms));

    const send = screen.getByRole('button', { name: ru.signIn.sendLink });
    expect(
      (send as HTMLButtonElement).disabled,
      'рекламное согласие оказалось обязательным',
    ).toBe(false);
  });

  it('рекламное согласие уезжает отдельным полем, а не в нагрузку', async () => {
    const app = await mount();
    const sent = vi.spyOn(app, 'sendMagicLink').mockResolvedValue(true);

    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });
    fireEvent.click(box(ru.signIn.consentTerms));
    fireEvent.click(screen.getByRole('button', { name: ru.signIn.sendLink }));

    expect(sent).toHaveBeenCalledWith('marina@ya.ru', { marketing: false });
    app.dispose();
  });

  it('поставленное рекламное согласие доезжает как `true`', async () => {
    /* Отдельная сборка экрана, а не второе нажатие: после первого письма
       экран переходит в «письмо ушло», и формы там уже нет. */
    const app = await mount();
    const sent = vi.spyOn(app, 'sendMagicLink').mockResolvedValue(true);

    const email = document.querySelector('input[type="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'marina@ya.ru' } });
    fireEvent.click(box(ru.signIn.consentTerms));
    fireEvent.click(box(ru.signIn.consentMarketing));
    fireEvent.click(screen.getByRole('button', { name: ru.signIn.sendLink }));

    expect(sent).toHaveBeenCalledWith('marina@ya.ru', { marketing: true });
    app.dispose();
  });

  it('документы даны ссылками: согласие вслепую — не согласие', async () => {
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
