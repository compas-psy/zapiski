/**
 * FolderPicker: иерархическое дерево вместо плоского списка путей (MVP §16-21).
 *
 * Заказчик (аудит): `FolderPickerDialog` получал `readonly string[]` из
 * `flattenFolders()` и показывал каждый путь отдельной одинаковой кнопкой —
 * «Работа», «Работа/Клиенты», «Работа/Клиенты/Иван» в одну плоскую ленту.
 * Комментарий в исходнике фиксировал это как сознательный выбор: «дерево
 * внутри дерева читается хуже». Пользователь увидел в этом «максимально
 * уродливый и неструктурированный список папок».
 *
 * `LibraryPanel` уже показывает те же папки существующим `Tree` — этот файл
 * проверяет, что диалог выбора получателя переведён на тот же компонент, а не
 * получил собственное дерево (§17: «не создавать новый FolderTree»).
 */
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import type { FolderNode } from '@zapiski/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildFolderDestinationTree,
  FolderPickerDialog,
  NO_CURRENT_LOCATION,
} from '../src/components/FolderDialogs.js';
import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');
afterEach(cleanup);

function folder(path: string, name: string, children: FolderNode[] = [], system = false): FolderNode {
  return { path, name, children, count: 0, ...(system ? { system: true } : {}) };
}

/**
 * Работа/
 *   Клиенты/
 *     Архив/
 *   Проекты/
 *     2026/
 * Личное/
 *   Архив/
 * Images/ (system)
 */
const TREE: FolderNode[] = [
  folder('Работа', 'Работа', [
    folder('Работа/Клиенты', 'Клиенты', [folder('Работа/Клиенты/Архив', 'Архив')]),
    folder('Работа/Проекты', 'Проекты', [folder('Работа/Проекты/2026', '2026')]),
  ]),
  folder('Личное', 'Личное', [folder('Личное/Архив', 'Архив')]),
  folder('Images', 'Images', [], true),
];

describe('buildFolderDestinationTree — чистая функция (§19)', () => {
  it('исключает системные папки вложений', () => {
    const result = buildFolderDestinationTree(TREE, { current: '' });
    expect(result.some((n) => n.path === 'Images')).toBe(false);
  });

  it('текущая папка остаётся в дереве структурным родителем — не поднимает детей в root', () => {
    /*
     * Первая редакция убирала узел `current` и поднимала его детей на его
     * место — при одинаковых basename в разных ветках это стирало разницу
     * между ними (см. отдельный тест ниже с двумя «Архив»). Правильная
     * модель: сама папка остаётся в дереве (её просто нельзя выбрать —
     * это решает `toPickerTree`/`disabled`, не эта функция), а её дети
     * — там же, где были, под тем же родителем.
     */
    const result = buildFolderDestinationTree(TREE, { current: 'Работа' });
    const work = result.find((n) => n.path === 'Работа');
    expect(work, 'узел «Работа» пропал из дерева').toBeDefined();
    expect(work?.children.map((c) => c.path)).toEqual(['Работа/Клиенты', 'Работа/Проекты']);
    // И структура top-level не поменялась: «Работа» и «Личное» — сёстры, не слиты.
    expect(result.map((n) => n.path)).toEqual(['Работа', 'Личное']);
  });

  it('одинаковые basename при переносе ИЗ одной из веток не путаются между собой', () => {
    // §21: Архив в корне + Работа/Архив + Личное/Архив, перенос из «Работа».
    const withRootArchive: FolderNode[] = [
      folder('Архив', 'Архив'),
      folder('Работа', 'Работа', [folder('Работа/Архив', 'Архив')]),
      folder('Личное', 'Личное', [folder('Личное/Архив', 'Архив')]),
    ];
    const result = buildFolderDestinationTree(withRootArchive, { current: 'Работа' });
    const allPaths: string[] = [];
    const collect = (nodes: readonly FolderNode[], depth: number): void => {
      for (const n of nodes) {
        allPaths.push(n.path);
        collect(n.children, depth + 1);
      }
    };
    collect(result, 0);
    // Все три «Архив» присутствуют, и каждый — под СВОИМ путём, не слиты в один.
    expect(allPaths).toEqual(['Архив', 'Работа', 'Работа/Архив', 'Личное', 'Личное/Архив']);
    expect(new Set(allPaths).size).toBe(allPaths.length);
  });

  it('перенос папки исключает её саму и всех потомков целиком', () => {
    // Сценарий §21 «перенос folder»: переносим «Работа/Проекты».
    const result = buildFolderDestinationTree(TREE, { source: 'Работа/Проекты', current: 'Работа' });
    const allPaths: string[] = [];
    const collect = (nodes: readonly FolderNode[]): void => {
      for (const n of nodes) {
        allPaths.push(n.path);
        collect(n.children);
      }
    };
    collect(result);
    expect(allPaths).not.toContain('Работа/Проекты');
    expect(allPaths).not.toContain('Работа/Проекты/2026');
  });

  it('одинаковые basename остаются структурно различимы деревом', () => {
    const result = buildFolderDestinationTree(TREE, { current: '' });
    const workNode = result.find((n) => n.path === 'Работа');
    const personalNode = result.find((n) => n.path === 'Личное');
    // Оба «Архив» существуют, но каждый — под своим родителем в СВОЁМ пути.
    expect(workNode?.children.find((c) => c.name === 'Клиенты')?.children[0]?.path).toBe('Работа/Клиенты/Архив');
    expect(personalNode?.children[0]?.path).toBe('Личное/Архив');
  });

  it('пустое дерево даёт пустой результат', () => {
    expect(buildFolderDestinationTree([], { current: '' })).toEqual([]);
  });

  it('NO_CURRENT_LOCATION не совпадает ни с одним путём — ничего не прячет', () => {
    const result = buildFolderDestinationTree(TREE, { current: NO_CURRENT_LOCATION });
    expect(result.some((n) => n.path === 'Работа')).toBe(true);
  });
});

/**
 * Смонтированный диалог. `FolderPickerDialog` берёт строки через
 * `useStrings()` (`useApp()` изнутри) — минимальный настоящий контроллер
 * вместо мока контекста, тот же приём, что и в остальных тестах экрана.
 */
async function mountPicker(
  props: Partial<React.ComponentProps<typeof FolderPickerDialog>> = {},
): Promise<{ onPick: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const host = createTestHost({ files: {}, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <FolderPickerDialog
            open
            current=""
            folders={TREE}
            onPick={onPick}
            onClose={onClose}
            {...props}
          />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return { onPick, onClose };
}

describe('FolderPickerDialog — рендер поверх Tree (§18, §21)', () => {
  it('показывает basename, а не полный путь', async () => {
    await mountPicker();
    expect(screen.getByRole('treeitem', { name: 'Клиенты' })).toBeTruthy();
    expect(screen.queryByText('Работа/Клиенты')).toBeNull();
  });

  it('роли ARIA: tree и treeitem', async () => {
    await mountPicker();
    expect(screen.getByRole('tree')).toBeTruthy();
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('клик по названию выбирает папку и закрывает диалог одним нажатием', async () => {
    const { onPick, onClose } = await mountPicker();
    fireEvent.click(screen.getByRole('treeitem', { name: 'Проекты' }));
    expect(onPick).toHaveBeenCalledWith('Работа/Проекты');
    expect(onClose).toHaveBeenCalled();
  });

  it('«В корень» скрыт, когда объект уже в корне', async () => {
    await mountPicker({ current: '' });
    expect(screen.queryByRole('button', { name: ru.library.moveToRoot })).toBeNull();
  });

  it('«В корень» — отдельным верхним пунктом, выбирает корень', async () => {
    const { onPick } = await mountPicker({ current: 'Работа' });
    fireEvent.click(screen.getByRole('button', { name: ru.library.moveToRoot }));
    expect(onPick).toHaveBeenCalledWith('');
  });

  it('перенос папки: она сама и потомки не показываются', async () => {
    await mountPicker({ source: 'Работа/Проекты', current: 'Работа' });
    expect(screen.queryByRole('treeitem', { name: 'Проекты' })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: '2026' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'Клиенты' })).toBeTruthy();
  });

  describe('текущая папка — видимый, но невыбираемый родитель (structural edge-case)', () => {
    it('строка «Работа» видна, помечена суффиксом и aria-disabled', async () => {
      await mountPicker({ current: 'Работа' });
      const row = screen.getByRole('treeitem', { name: `Работа · ${ru.library.currentLocationSuffix}` });
      expect(row).toBeTruthy();
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(row.getAttribute('aria-selected')).not.toBe('true');
    });

    it('клик по названию текущей папки ничего не выбирает', async () => {
      const { onPick, onClose } = await mountPicker({ current: 'Работа' });
      const row = screen.getByRole('treeitem', { name: `Работа · ${ru.library.currentLocationSuffix}` });
      fireEvent.click(row);
      expect(onPick).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('дети текущей папки остаются видны и выбираемы под ней', async () => {
      const { onPick } = await mountPicker({ current: 'Работа' });
      expect(screen.getByRole('treeitem', { name: 'Клиенты' })).toBeTruthy();
      expect(screen.getByRole('treeitem', { name: 'Проекты' })).toBeTruthy();
      fireEvent.click(screen.getByRole('treeitem', { name: 'Клиенты' }));
      expect(onPick).toHaveBeenCalledWith('Работа/Клиенты');
    });

    it('одинаковые basename в разных ветках однозначно различимы при активном current', async () => {
      const withRootArchive: FolderNode[] = [
        folder('Архив', 'Архив'),
        folder('Работа', 'Работа', [folder('Работа/Архив', 'Архив')]),
        folder('Личное', 'Личное', [folder('Личное/Архив', 'Архив')]),
      ];
      const { onPick } = await mountPicker({ folders: withRootArchive, current: 'Работа' });
      // Три строки с именем «Архив» — корневая, под disabled-«Работа», под «Личное».
      const archives = screen.getAllByRole('treeitem', { name: 'Архив' });
      expect(archives).toHaveLength(3);
      // Клик по КОРНЕВОМУ «Архив» (первому в DOM-порядке) выбирает именно его,
      // а не тот, что внутри «Работа» или «Личное» — структура решает вопрос.
      const rootArchive = archives[0];
      if (!rootArchive) throw new Error('строка «Архив» не найдена');
      fireEvent.click(rootArchive);
      expect(onPick).toHaveBeenCalledWith('Архив');
    });
  });

  it('пустое хранилище — доступен только «В корень»', async () => {
    await mountPicker({ folders: [], current: NO_CURRENT_LOCATION });
    expect(screen.getByRole('button', { name: ru.library.moveToRoot })).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('Escape закрывает диалог', async () => {
    const { onClose } = await mountPicker();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('FolderPickerDialog внутри приложения — не вторая реализация дерева', () => {
  it('открытие файла через настоящий стор создаёт заметку во вложенной папке выбором из дерева', async () => {
    const host = createTestHost({
      files: { 'Работа/Проекты/.keep': '' },
      prefs: { onboarded: true },
    });
    const app = new AppController(host);
    await app.boot();

    function Harness(): ReactElement {
      return (
        <FolderPickerDialog
          open
          current={NO_CURRENT_LOCATION}
          folders={app.getState().folders}
          title="Куда сохранить «Идея.md»"
          onPick={(parent) => void app.importOpenedFile('Идея.md', new TextEncoder().encode('# Идея\n'), parent)}
          onClose={() => undefined}
        />
      );
    }

    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <Harness />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('treeitem', { name: 'Проекты' }));
    await vi.waitFor(() => {
      expect(app.getState().notes.some((n) => n.path === 'Работа/Проекты/Идея.md')).toBe(true);
    });
  });
});
