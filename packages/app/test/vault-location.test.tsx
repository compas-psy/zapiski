/**
 * Где лежат заметки: выбор папки и честное предупреждение (ТЗ §4.1 п. 1, §4.3).
 *
 * Приёмка нашла место, где формальное соответствие ТЗ ухудшило продукт: на
 * Android выбора папки не было вовсе, потому что SAF не даёт атомарной
 * записи. Ценой стал ключевой бесплатный сценарий §4.1 п. 1 — заметки в
 * папке, которую синхронизирует сторонний клиент.
 *
 * Здесь проверяется договор: выбор есть, умолчание не изменилось, а
 * предупреждение появляется ровно тогда, когда запись не атомарна.
 */
import {
  catalog,
  MemoryVaultStorage,
  type PlatformCapabilities,
  type VaultFolderPicker,
  type VaultLocation,
} from '@zapiski/core';
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { createTestHost } from './host.js';

// Каталог ядра, а не экранов: тексты про хранилище живут там же, где их берёт
// контроллер (`app.storageStrings`), — иначе тест сверялся бы с копией.
const ru = catalog('ru');

const FILES = { 'Заметка.md': '# Заметка\n' };

/** Папка пользователя со своим набором возможностей. */
function picker(chosen: Omit<VaultLocation, 'storage'>, files: Record<string, string> = {}): VaultFolderPicker {
  const storage = new MemoryVaultStorage({ files });
  return {
    async chooseFolder() {
      return { ...chosen, storage };
    },
    async useAppFolder() {
      return {
        kind: 'app',
        writeMode: 'atomic',
        label: 'Записки',
        storage: new MemoryVaultStorage({ files: FILES }),
      };
    },
    async current() {
      return { kind: 'app', writeMode: 'atomic', label: 'Записки' };
    },
  };
}

/** Тексты тостов последнего поднятого контроллера — их видит пользователь. */
let toasts: string[] = [];

async function boot(platform: Partial<PlatformCapabilities> = {}): Promise<AppController> {
  const host = createTestHost({ files: FILES, prefs: { onboarded: true }, platform });
  toasts = [];
  const app = new AppController(host, (toast) => toasts.push(toast.message));
  await app.boot();
  return app;
}

describe('где лежат заметки — ТЗ §4.1 п. 1', () => {
  it('без порта выбора папки нет ни выбора, ни предупреждения', async () => {
    const app = await boot();
    expect(app.canChooseVaultFolder).toBe(false);
    expect(app.vaultLocationWarning).toBeNull();
    expect(await app.chooseVaultFolder()).toBeNull();
    app.dispose();
  });

  it('умолчание — каталог приложения, и предупреждать не о чем', async () => {
    const app = await boot({ vaultFolders: picker({ kind: 'app', writeMode: 'atomic', label: 'Записки' }) });
    expect(app.canChooseVaultFolder).toBe(true);
    expect(app.getState().vaultLocation).toEqual({ kind: 'app', writeMode: 'atomic', label: 'Записки' });
    expect(app.vaultLocationWarning).toBeNull();
    app.dispose();
  });

  it('выбранная папка без переименования: заметки читаются, предупреждение честное', async () => {
    const app = await boot({
      vaultFolders: picker({ kind: 'user', writeMode: 'direct', label: 'Яндекс.Диск/Записки' }, {
        'Из облака.md': '# Из облака\n',
      }),
    });

    const chosen = await app.chooseVaultFolder();
    expect(chosen).toEqual({ kind: 'user', writeMode: 'direct', label: 'Яндекс.Диск/Записки' });
    /* Vault переехал: список берётся из выбранной папки. */
    expect(app.getState().notes.map((note) => note.path)).toContain('Из облака.md');

    const warning = app.vaultLocationWarning;
    expect(warning).toContain(app.storageStrings.directNote);
    /* И то же самое сказано вслух в момент выбора, а не только в настройках. */
    expect(toasts.at(-1)).toContain(app.storageStrings.directNote);
    /* Цена названа, но и польза тоже — иначе это запугивание, а не честность. */
    expect(warning).toContain(app.storageStrings.why);
    /* Тон продукта: без восклицательных знаков (VOICE, BEHAVIOR §11). */
    expect(warning).not.toContain('!');
    app.dispose();
  });

  it('провайдер с переименованием — предупреждение мягче, но оно есть', async () => {
    const app = await boot({
      vaultFolders: picker({ kind: 'user', writeMode: 'staged', label: 'Документы' }),
    });
    await app.chooseVaultFolder();
    expect(app.vaultLocationWarning).toContain(app.storageStrings.stagedNote);
    expect(app.vaultLocationWarning).not.toContain(app.storageStrings.directNote);
    app.dispose();
  });

  it('можно вернуться в каталог приложения', async () => {
    const app = await boot({
      vaultFolders: picker({ kind: 'user', writeMode: 'direct', label: 'Флешка' }),
    });
    await app.chooseVaultFolder();
    expect(app.vaultLocationWarning).not.toBeNull();

    const back = await app.useAppVaultFolder();
    expect(back?.kind).toBe('app');
    expect(app.vaultLocationWarning).toBeNull();
    expect(app.getState().notes.map((note) => note.path)).toContain('Заметка.md');
    app.dispose();
  });

  it('отмена выбора ничего не меняет (BEHAVIOR §0)', async () => {
    const cancelling: VaultFolderPicker = {
      async chooseFolder() {
        return null;
      },
      async useAppFolder() {
        return null;
      },
      async current() {
        return { kind: 'app', writeMode: 'atomic', label: 'Записки' };
      },
    };
    const app = await boot({ vaultFolders: cancelling });
    expect(await app.chooseVaultFolder()).toBeNull();
    expect(app.getState().vaultLocation?.kind).toBe('app');
    expect(app.getState().notes.map((note) => note.path)).toContain('Заметка.md');
    app.dispose();
  });
});

/**
 * Экран, а не только контроллер.
 *
 * ТЗ §8 D3 и ARCHITECTURE §1: отсутствующая возможность **скрыта, а не
 * выключена**. Серая кнопка «Выбрать папку» на Windows была бы обещанием,
 * которое платформа не выполняет, — поэтому её там нет вовсе.
 *
 * И обратное: там, где выбор есть, предупреждение о неатомарной записи должно
 * стоять на экране постоянно, а не мелькать одним тостом. Человек платит
 * надёжностью, и цену он вправе видеть, пока папка выбрана.
 */
describe('раздел «Хранилище» — экран', () => {
  async function mountStorage(platform: Partial<PlatformCapabilities> = {}): Promise<void> {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true }, platform });
    const app = new AppController(host);
    await app.boot();
    render(
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <SettingsScreen section="storage" />
        </AppProvider>
      </ToastProvider>,
    );
  }

  it('без порта выбора папки кнопки нет вовсе — не серой, а никакой', async () => {
    await mountStorage();
    expect(screen.queryByRole('button', { name: ru.storage.chooseFolder })).toBeNull();
    expect(screen.queryByText(ru.storage.warningTitle)).toBeNull();
  });

  it('с портом выбор появляется, и рядом сказано, зачем он нужен', async () => {
    await mountStorage({
      vaultFolders: picker({ kind: 'user', writeMode: 'direct', label: 'Яндекс.Диск' }),
    });
    expect(screen.getByRole('button', { name: ru.storage.chooseFolder })).toBeTruthy();
    // Польза названа вместе с ценой, а не вместо неё.
    expect(screen.getByText(ru.storage.why)).toBeTruthy();
  });

  it('в папке приложения предупреждать не о чем — стоит спокойная заметка', async () => {
    await mountStorage({
      vaultFolders: picker({ kind: 'user', writeMode: 'direct', label: 'Яндекс.Диск' }),
    });
    expect(screen.queryByText(ru.storage.warningTitle)).toBeNull();
    expect(screen.getByText(ru.storage.appFolderNote)).toBeTruthy();
  });
});
