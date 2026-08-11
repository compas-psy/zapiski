/**
 * Лист шифрования не зависает (жалоба «Encrypt в Windows после ввода пароля
 * зависает»).
 *
 * Настоящая причина отказа была в CSP оболочки: Argon2id считается в
 * WebAssembly, а `script-src 'self'` без `'wasm-unsafe-eval'` запрещает его
 * инстанцировать. Причина устранена в `tauri.conf.json`.
 *
 * Но вечное вращение кнопки — отдельный дефект, и чинится он отдельно.
 * В `submit()` не было `try`: при любом отказе `setBusy(false)` просто не
 * выполнялся, и кнопка крутилась, пока человек не закрывал приложение. Причин
 * отказать у шифрования будет ещё много — кончилось место, отозвано разрешение
 * на папку, — и ни одна из них не должна превращаться в зависший экран.
 *
 * Поэтому проверка не про CSP, а про поведение: что бы ни случилось, человек
 * получает строку из реестра и возможность повторить.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { AppProvider } from '../src/state/context.js';
import { EncryptSheet } from '../src/screens/EncryptSheet.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');
const PASSWORD = 'верный длинный пароль';

async function mountSheet(files: Record<string, string> = { 'Заметка.md': '# Заметка\n\nтекст\n' }) {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <EncryptSheet open path="Заметка.md" onClose={() => {}} />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return { app };
}

/** Заполняет пароль и повтор — так, как это делает человек. */
async function fillPassword(): Promise<void> {
  const fields = await screen.findAllByLabelText(/пароль/i);
  for (const field of fields.slice(0, 2)) {
    fireEvent.change(field, { target: { value: PASSWORD } });
  }
}

describe('лист шифрования переживает отказ', () => {
  it('при отказе кнопка перестаёт крутиться', async () => {
    const { app } = await mountSheet();
    /* Ровно то, что делала запрещённая CSP: Argon2id не досчитался. */
    vi.spyOn(app, 'setVaultPassword').mockRejectedValue(new Error('wasm заблокирован'));

    await fillPassword();
    const button = screen.getByRole('button', { name: ru.crypto.encrypt });
    fireEvent.click(button);

    await waitFor(() => {
      /* `loading` у кнопки выражается через aria-busy — крутится она или нет. */
      expect(button.getAttribute('aria-busy')).not.toBe('true');
    });
  });

  it('при отказе человек видит строку, а не пустоту', async () => {
    const { app } = await mountSheet();
    vi.spyOn(app, 'setVaultPassword').mockRejectedValue(new Error('wasm заблокирован'));

    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: ru.crypto.encrypt }));

    /* Тост ищется на экране, а не в перехватчике: приёмник ставит
       `AppProvider`, и подменять его значило бы проверять не то, что видно. */
    expect(await screen.findByText(ru.errors.encryptFailed)).toBeTruthy();
  });

  it('заметка, которой нет, тоже не подвешивает лист', async () => {
    /* `encryptNote` возвращает null, а не бросает: отдельная ветка. */
    await mountSheet({});
    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: ru.crypto.encrypt }));

    expect(await screen.findByText(ru.errors.encryptFailed)).toBeTruthy();
  });
});

describe('оболочкам разрешён WebAssembly', () => {
  it('CSP обеих Tauri-сборок пускает wasm', async () => {
    /* Без `wasm-unsafe-eval` Argon2id не инстанцируется, и шифрование
       отказывает молча — ровно то, что видел пользователь на Windows. */
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    for (const shell of ['desktop', 'mobile']) {
      const config = JSON.parse(
        readFileSync(
          resolve(__dirname, `../../../apps/${shell}/src-tauri/tauri.conf.json`),
          'utf8',
        ),
      ) as { app: { security: { csp: string } } };
      expect(config.app.security.csp, shell).toContain("'wasm-unsafe-eval'");
    }
  });
});
