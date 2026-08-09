/**
 * Папки: создание, переименование, удаление.
 *
 * Требование BEHAVIOR («Дерево папок… меню: Новая подпапка · Переименовать ·
 * Переместить · Удалить») до сих пор существовало на экране в виде надписей.
 * «Новая подпапка» звала создание ЗАМЕТКИ, «Переименовать» имела пустой
 * обработчик `() => undefined`. Пользователь на живом Windows сформулировал
 * это в одну строку: «Папки нельзя создать».
 *
 * Здесь проверяется не только то, что операции работают, но и то, что до них
 * можно дотянуться из интерфейса, — второе оказалось важнее.
 */
import { render, screen } from '@testing-library/react';
import { catalog } from '@zapiski/core';
import { ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { LibraryPanel } from '../src/screens/LibraryPanel.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

async function boot(files: Record<string, string> = {}): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

describe('папки', () => {
  it('создаются и переживают обход дерева', async () => {
    const app = await boot();
    expect(app.getState().folders).toHaveLength(0);

    const created = await app.createFolder('', 'Практика');
    expect(created).toBe('Практика');

    const names = app.getState().folders.map((node) => node.name);
    expect(names).toContain('Практика');
  });

  it('пустая папка видна в дереве — она настоящий каталог, а не выдумка', async () => {
    const app = await boot();
    await app.createFolder('', 'Пустая');

    // Ни одной заметки внутри, а папка есть: обещание «файл важнее приложения»
    // означает, что структуру можно разложить заранее.
    expect(app.getState().notes).toHaveLength(0);
    expect(app.getState().folders.map((node) => node.name)).toContain('Пустая');
  });

  it('одноимённая папка получает свободное имя, а не ошибку', async () => {
    const app = await boot();
    await app.createFolder('', 'Практика');
    const second = await app.createFolder('', 'Практика');
    expect(second).toBe('Практика 2');
  });

  it('подпапка создаётся внутри родителя', async () => {
    const app = await boot();
    await app.createFolder('', 'Практика');
    const child = await app.createFolder('Практика', 'Супервизии');
    expect(child).toBe('Практика/Супервизии');
  });

  it('переименование двигает заметки и не теряет их', async () => {
    const app = await boot({ 'Практика/Заметка.md': '# Заметка\n\nтекст\n' });
    const before = app.getState().notes.length;

    const to = await app.renameFolder('Практика', 'Работа');
    expect(to).toBe('Работа');

    expect(app.getState().notes).toHaveLength(before);
    expect(app.getState().notes[0]!.path).toBe('Работа/Заметка.md');
    expect(await app.vaultRef!.storage.read('Практика/Заметка.md')).toBeNull();
  });

  it('удаление «с заметками» кладёт их в корзину, а не стирает', async () => {
    const app = await boot({ 'Практика/Заметка.md': '# Заметка\n\nтекст\n' });

    const count = await app.deleteFolder('Практика', 'notes-to-trash');
    expect(count).toBe(1);
    expect(app.getState().notes).toHaveLength(0);
    // ТЗ: ни одно действие не теряет текст безвозвратно.
    expect(app.getState().trash.some((entry) => entry.title === 'Заметка')).toBe(true);
  });

  it('удаление «только папки» поднимает заметки к родителю', async () => {
    const app = await boot({ 'Практика/Заметка.md': '# Заметка\n\nтекст\n' });

    await app.deleteFolder('Практика', 'notes-to-parent');

    expect(app.getState().trash).toHaveLength(0);
    expect(app.getState().notes[0]!.path).toBe('Заметка.md');
  });
});

/**
 * Сторож против класса «код есть, кнопки нет».
 *
 * Именно этот класс дал три дефекта подряд: возможность реализована в ядре,
 * покрыта тестом, а из интерфейса недостижима. Модульный тест такого не видит
 * по устройству: он зовёт метод напрямую, минуя экран.
 */
describe('до папок можно дотянуться из библиотеки', () => {
  async function mountLibrary(files: Record<string, string> = {}): Promise<void> {
    const host = createTestHost({ files, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    render(
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <LibraryPanel />
        </AppProvider>
      </ToastProvider>,
    );
  }

  it('на пустом хранилище есть чем создать первую папку', async () => {
    await mountLibrary();
    // Меню папки открывается долгим нажатием НА ПАПКУ. Пока папок нет,
    // единственный путь — кнопка в пустом состоянии. Без неё первую папку
    // создать было нечем вообще, что пользователь и обнаружил.
    expect(screen.getByRole('button', { name: ru.library.newFolder })).toBeTruthy();
  });

  it('когда папки есть, создание доступно рядом с их списком', async () => {
    await mountLibrary({ 'Практика/Заметка.md': '# Заметка\n' });
    expect(screen.getByRole('button', { name: ru.library.newFolder })).toBeTruthy();
  });

  it('тексты берутся из каталога, а не пишутся в разметке', () => {
    // Каталог ядра и каталог экранов — разные; папки живут в экранном.
    expect(ru.library.newFolder).toBe('Новая папка');
    expect(ru.library.deleteFolder).toBe('Удалить папку');
    expect(catalog('ru').errors.linksUpdated(2)).toContain('2');
  });
});
