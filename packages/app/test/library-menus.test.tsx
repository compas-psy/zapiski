/**
 * Сторож достижимости меню библиотеки.
 *
 * Он написан после того, как я объявил класс «код есть, кнопки нет» закрытым,
 * а он оказался открыт в том же файле: `setFolderMenu` и `setTagMenu`
 * вызывались ТОЛЬКО с `null` из `onClose`. Меню существовало, его пункты были
 * подключены к настоящим действиям — и открыть его было нечем. Четыре пункта
 * BEHAVIOR §3 («Новая подпапка · Переименовать · Переместить · Удалить») и
 * переименование тега были недостижимы с любого устройства.
 *
 * Предыдущий сторож этого не увидел, потому что проверял наличие КНОПКИ
 * «Новая папка» — то есть ровно то, что я тогда починил. Поэтому здесь
 * проверяется не наличие элемента, а срабатывание ЖЕСТА, которым ТЗ велит
 * меню открывать, и то, что каждый пункт доводит до действия.
 *
 * Правый клик, а не долгое удержание: `useLongPress` трактует `contextmenu`
 * как тот же жест без ожидания 500 мс (это его код, не допущение теста), и
 * ждать таймер в каждом случае значило бы удлинить прогон впустую.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@zapiski/ui';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { LibraryPanel } from '../src/screens/LibraryPanel.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

async function mount(files: Record<string, string>): Promise<AppController> {
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
  return app;
}

/** Узел дерева по подписи. Именно тот элемент, по которому жмёт человек. */
function treeItem(label: string): HTMLElement {
  const node = screen
    .getAllByRole('treeitem')
    .find((item) => item.textContent?.includes(label));
  if (!node) throw new Error(`в дереве нет узла «${label}»`);
  return node;
}

describe('меню папки открывается жестом из ТЗ', () => {
  const files = { 'Практика/Заметка.md': '# Заметка\n\nтекст\n' };

  it('долгое нажатие по папке открывает меню', async () => {
    await mount(files);
    fireEvent.contextMenu(treeItem('Практика'));
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy());
  });

  it('в меню все четыре пункта BEHAVIOR §3, ни одного лишнего', async () => {
    await mount(files);
    fireEvent.contextMenu(treeItem('Практика'));
    const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(labels).toEqual([
      ru.library.newSubfolder,
      ru.library.rename,
      ru.library.moveFolder,
      ru.library.deleteFolder,
    ]);
  });

  it('«Переименовать» доводит до поля ввода имени', async () => {
    await mount(files);
    fireEvent.contextMenu(treeItem('Практика'));
    fireEvent.click(await screen.findByRole('menuitem', { name: ru.library.rename }));
    expect(await screen.findByLabelText(ru.library.folderNamePrompt)).toBeTruthy();
  });

  it('«Переместить» доводит до выбора получателя', async () => {
    await mount({ ...files, 'Работа/Другая.md': '# Другая\n' });
    fireEvent.contextMenu(treeItem('Практика'));
    fireEvent.click(await screen.findByRole('menuitem', { name: ru.library.moveFolder }));
    // В получателях — «Работа», но не сама «Практика»: класть папку внутрь
    // себя нельзя, и показывать такой пункт значило бы обещать несбыточное.
    expect(await screen.findByRole('treeitem', { name: 'Работа' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'Практика' })).toBeNull();
  });

  it('«Удалить папку» доводит до выбора исхода, а не удаляет молча', async () => {
    const app = await mount(files);
    fireEvent.contextMenu(treeItem('Практика'));
    fireEvent.click(await screen.findByRole('menuitem', { name: ru.library.deleteFolder }));
    expect(await screen.findByRole('button', { name: ru.library.deleteFolderOnly })).toBeTruthy();
    // Пока человек не выбрал — на диске ничего не изменилось.
    expect(app.getState().notes).toHaveLength(1);
  });
});

describe('меню тега открывается тем же жестом', () => {
  const files = { 'Заметка.md': '# Заметка\n\n#практика и текст\n' };

  it('долгое нажатие по тегу открывает меню с «Переименовать»', async () => {
    await mount(files);
    fireEvent.contextMenu(treeItem('#практика'));
    expect(await screen.findByRole('menuitem', { name: ru.library.rename })).toBeTruthy();
  });

  it('пункт доводит до поля ввода с текущим именем тега', async () => {
    await mount(files);
    fireEvent.contextMenu(treeItem('#практика'));
    fireEvent.click(await screen.findByRole('menuitem', { name: ru.library.rename }));
    const field = await screen.findByLabelText<HTMLInputElement>(ru.library.folderNamePrompt);
    expect(field.value).toBe('практика');
  });
});

/**
 * Вход в настройки.
 *
 * До этого теста экран настроек был недостижим НА ТЕЛЕФОНЕ ВООБЩЕ: попасть в
 * него можно было только по Ctrl+, или через палитру команд (Ctrl+K) — то есть
 * с клавиатуры, которой на Android нет. За ним заперты выбор темы и акцента,
 * размер шрифта, шифрование, синхронизация и хранилище. Отсюда и «нельзя
 * сменить темы», и «почти никакой функционал не работает».
 */
describe('настройки достижимы без клавиатуры', () => {
  it('в библиотеке есть кнопка «Настройки»', async () => {
    await mount({});
    expect(screen.getByRole('button', { name: ru.settings.title })).toBeTruthy();
  });

  it('она открывает экран настроек, а не просто закрывает панель', async () => {
    const app = await mount({});
    fireEvent.click(screen.getByRole('button', { name: ru.settings.title }));
    const route = app.getState().route;
    expect(route.name).toBe('settings');
    // Первым разделом — «Внешний вид»: там темы, из-за которых и спрашивали.
    expect(route.name === 'settings' && route.section).toBe('appearance');
  });
});
