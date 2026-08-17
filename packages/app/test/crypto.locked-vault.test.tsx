/**
 * Закрытое хранилище: соль на диске есть, ключа в памяти нет.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Пароль хранилища задаётся ОДИН раз за всю его жизнь (ТЗ §3.3), а ключ живёт
 * только в памяти сеанса. Значит после каждого перезапуска приложения
 * существует состояние «пароль есть, ключа нет» — и попасть в него можно
 * просто закрыв приложение.
 *
 * Лист шифрования этого состояния не знал. Он спрашивал `hasVaultPassword()` —
 * «соль есть на диске», — а `encryptNote` требует ключ; при несовпадении
 * возвращался `null`, и человек получал «Не удалось зашифровать заметку ·
 * Повторить». «Повторить» повторяло отказ, а ввести пароль было негде: его
 * спрашивает только замок УЖЕ зашифрованной заметки. То есть зашифровать
 * первую заметку после перезапуска стало НЕВОЗМОЖНО, и вышло это ровно так,
 * как описал заказчик.
 *
 * Геттер `vaultUnlocked` для этого состояния существовал — и не спрашивался ни
 * одним продуктовым файлом, только тестами. Это и есть та разновидность
 * дефекта, которую тысяча зелёных тестов не видит: каждый из них живёт в одном
 * сеансе, где пароль только что задали.
 *
 * ── Что проверяется ─────────────────────────────────────────────────────────
 *
 * Перезапуск подделывается честно: тот же хост (то же хранилище, те же
 * настройки), новый контроллер. Именно это и происходит на устройстве.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import type { BiometricProvider, VaultPath } from '@zapiski/core';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { EncryptSheet } from '../src/screens/EncryptSheet.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');
const PASSWORD = 'верный пароль';
const FILES = {
  'Работа/Смета.md': '# Смета\n\nчисла по смете\n',
  'Работа/План.md': '# План\n\nпункты плана\n',
};

/** Хост живёт дольше контроллера — как папка живёт дольше запуска. */
function createShell(options: { biometrics?: BiometricProvider | null } = {}) {
  const host = createTestHost({
    files: FILES,
    prefs: { onboarded: true },
    ...(options.biometrics === undefined ? {} : { platform: { biometrics: options.biometrics } }),
  });
  const toasts: string[] = [];
  const boot = async (): Promise<AppController> => {
    const app = new AppController(host, (toast) => toasts.push(toast.message));
    await app.boot();
    return app;
  };
  return { host, toasts, boot };
}

function mount(app: AppController, host: ReturnType<typeof createTestHost>, path: VaultPath) {
  const closed: number[] = [];
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <EncryptSheet open path={path} onClose={() => closed.push(1)} />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return { closed };
}

describe('состояние замка хранилища', () => {
  it('после перезапуска хранилище закрыто, а не «пароля нет»', async () => {
    const shell = createShell();
    const first = await shell.boot();
    await first.setVaultPassword(PASSWORD);
    expect(await first.vaultLockState()).toBe('open');

    /* Перезапуск: та же папка, тот же диск, новый контроллер. */
    const second = await shell.boot();
    expect(second.vaultUnlocked).toBe(false);
    expect(await second.vaultLockState()).toBe('locked');
    /* И это НЕ «пароля ещё нет»: заводить его заново нельзя, иначе опечатка
       станет новым паролем хранилища. */
    expect(await second.hasVaultPassword()).toBe(true);
  });

  it('пустая папка без пароля — это «none»', async () => {
    const shell = createShell();
    const app = await shell.boot();
    expect(await app.vaultLockState()).toBe('none');
  });

  it('шифрование при закрытом хранилище называет причину, а не «не удалось»', async () => {
    const shell = createShell();
    const first = await shell.boot();
    await first.setVaultPassword(PASSWORD);
    const second = await shell.boot();

    expect(await second.encryptNote('Работа/Смета.md')).toBeNull();
    /* Разные новости — разные строки: «Повторить» здесь ничего не изменит. */
    expect(second.getState().syncError).toBe(ru.errors.vaultLocked);
    expect(second.getState().syncError).not.toBe(ru.errors.encryptFailed);
  });

  it('открытие паролем не требует ни одной зашифрованной заметки', async () => {
    const shell = createShell();
    const first = await shell.boot();
    await first.setVaultPassword(PASSWORD);
    /* Ни одной зашифрованной заметки нет — проверять пароль будет по
       контрольному образцу из `.zapiski/crypto.json`. */
    const second = await shell.boot();

    expect(await second.unlockVault('не тот')).toBe('wrong');
    expect(second.vaultUnlocked).toBe(false);
    expect(await second.unlockVault(PASSWORD)).toBe('ok');
    expect(second.vaultUnlocked).toBe(true);
  });
});

describe('лист шифрования доводит до конца после перезапуска', () => {
  it('просит пароль хранилища и шифрует заметку', async () => {
    const shell = createShell();
    const first = await shell.boot();
    await first.setVaultPassword(PASSWORD);
    const app = await shell.boot();
    const { closed } = mount(app, shell.host, 'Работа/Смета.md');

    /* Поле пароля — единственное: повтора у существующего пароля быть не может. */
    const field = await screen.findByLabelText(ru.crypto.password);
    expect(screen.queryByLabelText(ru.crypto.passwordRepeat)).toBeNull();

    fireEvent.change(field, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: ru.crypto.unlockAndEncrypt }));

    await waitFor(() => expect(closed.length).toBe(1));
    expect(app.getState().notes.some((note) => note.path === 'Работа/Смета.md.enc')).toBe(true);
  });

  it('неверный пароль назван словами, файл цел', async () => {
    const shell = createShell();
    const first = await shell.boot();
    await first.setVaultPassword(PASSWORD);
    const app = await shell.boot();
    const { closed } = mount(app, shell.host, 'Работа/Смета.md');

    fireEvent.change(await screen.findByLabelText(ru.crypto.password), {
      target: { value: 'не тот' },
    });
    fireEvent.click(screen.getByRole('button', { name: ru.crypto.unlockAndEncrypt }));

    expect(await screen.findByText(ru.errors.wrongPassword)).toBeTruthy();
    /* Лист остался открытым, а заметка — обычным файлом: неудачная попытка
       ничего не портит (BEHAVIOR §5.2). */
    expect(closed.length).toBe(0);
    expect(app.getState().notes.some((note) => note.path === 'Работа/Смета.md')).toBe(true);
    expect(app.getState().notes.some((note) => note.path === 'Работа/Смета.md.enc')).toBe(false);
  });

  it('в первый раз спрашивает пароль с повтором, а не одно поле', async () => {
    const shell = createShell();
    const app = await shell.boot();
    mount(app, shell.host, 'Работа/Смета.md');

    expect(await screen.findByLabelText(ru.crypto.passwordRepeat)).toBeTruthy();
    expect(screen.queryByText(ru.crypto.lockedVaultNote)).toBeNull();
  });
});

describe('тумблер биометрии обещает только то, что есть', () => {
  it('устройство умеет — тумблер показан', async () => {
    const provider: BiometricProvider = {
      isAvailable: async () => true,
      enroll: async () => undefined,
      unlock: async () => null,
      remove: async () => undefined,
    };
    const shell = createShell({ biometrics: provider });
    const app = await shell.boot();
    mount(app, shell.host, 'Работа/Смета.md');

    expect(await screen.findByRole('switch', { name: ru.crypto.biometricsToggle })).toBeTruthy();
  });

  it('порт есть, а возможности нет — тумблера нет вовсе', async () => {
    /*
     * Ровно эта развилка и стоила заказчику краха приложения. Порт на Android
     * заявлялся всегда, лист смотрел на его наличие — и предлагал отпечаток на
     * устройстве, где стойкой биометрии нет. Нажатие уводило в системный
     * диалог, которого там быть не могло.
     *
     * Выключенный тумблер здесь тоже неверен: BEHAVIOR §5.1 требует скрывать
     * то, чего нет, а не показывать недоступным.
     */
    const provider: BiometricProvider = {
      isAvailable: async () => false,
      enroll: async () => {
        throw new Error('на этом устройстве биометрии нет');
      },
      unlock: async () => null,
      remove: async () => undefined,
    };
    const shell = createShell({ biometrics: provider });
    const app = await shell.boot();
    mount(app, shell.host, 'Работа/Смета.md');

    await screen.findByLabelText(ru.crypto.passwordRepeat);
    expect(screen.queryByRole('switch', { name: ru.crypto.biometricsToggle })).toBeNull();
  });
});
