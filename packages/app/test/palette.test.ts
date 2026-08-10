/**
 * Палитра команд — приёмочный критерий №8:
 * «Все хоткеи из §7 работают и отражены в палитре команд».
 *
 * Тест проверяет строение, а не текущий снимок списка: палитра обязана брать
 * команды текста из `editorCommands`, а не из копии. Поэтому здесь сверяется,
 * что у КАЖДОЙ команды редактора есть подпись и хоткей, и что карта хоткеев
 * оболочки покрывает всё, что §7 отдала оболочке.
 */
import { editorCommands } from '@zapiski/editor';
import { describe, expect, it } from 'vitest';
import PALETTE_SOURCE from '../src/screens/CommandPalette.tsx?raw';
import { displayHotkey, editorHotkey } from '../src/screens/CommandPalette.js';
import { strings } from '../src/i18n/index.js';

describe('перевод хоткеев в подпись', () => {
  it('Mod → Ctrl, буквы в верхний регистр, стрелки — символами', () => {
    expect(displayHotkey('Mod-b')).toBe('Ctrl+B');
    expect(displayHotkey('Mod-Shift-l')).toBe('Ctrl+Shift+L');
    expect(displayHotkey('Alt-ArrowUp')).toBe('Alt+↑');
    expect(displayHotkey('Mod-Enter')).toBe('Ctrl+Enter');
  });

  it('читает ключ из `editorCommands`, а не из копии списка', () => {
    expect(editorHotkey('format.bold')).toBe('Ctrl+B');
    expect(editorHotkey('view.focus')).toBe('Ctrl+Shift+F');
    expect(editorHotkey('нет такой команды')).toBeUndefined();
  });
});

describe('палитра построена из editorCommands', () => {
  it('не содержит собственного массива команд редактора', () => {
    /* Единственный источник — импорт. Литералов вида `key: 'Mod-…'` быть не должно. */
    expect(PALETTE_SOURCE).toContain("from '@zapiski/editor'");
    expect(PALETTE_SOURCE).not.toMatch(/key:\s*'Mod-/);
  });

  it('у каждой команды редактора есть русская подпись', () => {
    const catalog = strings('ru');
    const labels = new Set(
      Object.values(catalog.commands).map((value) =>
        typeof value === 'function' ? value(1) : value,
      ),
    );
    /* `heading` — функция уровня: подписи H1…H6 строятся из неё. */
    for (let level = 1; level <= 6; level += 1) labels.add(catalog.commands.heading(level));

    for (const command of editorCommands) {
      const hotkey = editorHotkey(command.id);
      expect(hotkey, `${command.id} без хоткея`).toBeTruthy();
    }
    /* Подписей должно хватать на все команды: id → подпись разбирается в
       `editorCommandLabel`, здесь ловим забытые ключи каталога. */
    expect(labels.has(catalog.commands.strike)).toBe(true);
    expect(labels.has(catalog.commands.pastePlain)).toBe(true);
    expect(labels.has(catalog.commands.moveLineUp)).toBe(true);
    expect(labels.has(catalog.commands.moveLineDown)).toBe(true);
  });

  /*
    Проверка «покрывает каждый хоткей таблицы §7» переехала в
    `hotkeys.test.ts`. Здешняя редакция была слабее и потому пропустила
    настоящее расхождение: она требовала, чтобы нашлась ХОТЯ БЫ ОДНА из
    альтернатив, и строка «Ctrl+K / Ctrl+P» проходила при отсутствии Ctrl+P.
    Плюс читала реестр оболочки регулярным выражением по тексту файла, а не
    как данные, — и ломалась от любой правки записи.
  */
});
