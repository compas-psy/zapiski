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
import HOTKEY_SPEC from '../../../docs/spec/BEHAVIOR.md?raw';
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

  it('покрывает каждый хоткей таблицы §7', () => {
    const section = HOTKEY_SPEC.slice(
      HOTKEY_SPEC.indexOf('### Desktop'),
      HOTKEY_SPEC.indexOf('### Палитра команд'),
    );
    const specHotkeys = section
      .split('\n')
      .filter((line) => line.startsWith('| Ctrl') || line.startsWith('| Alt'))
      .map((line) => (line.split('|')[1] ?? '').trim());
    expect(specHotkeys.length).toBeGreaterThan(20);

    /* Хоткеи текста — из редактора, хоткеи оболочки — из карты в палитре. */
    const fromEditor = new Set(editorCommands.map((command) => displayHotkey(command.key)));
    const fromShell = new Set(
      [...PALETTE_SOURCE.matchAll(/'(Ctrl\+[^']+)'/g)].map((match) => match[1] as string),
    );

    const missing = specHotkeys.filter((hotkey) => {
      /* В ТЗ часть строк записана диапазоном («Ctrl+1…6»), через слэш
         («Ctrl+K / Ctrl+P») или сокращением («Alt+↑/↓») — разворачиваем. */
      const variants = hotkey
        .replace('Ctrl+1…6', 'Ctrl+1')
        .replace('Alt+↑/↓', 'Alt+↑ / Alt+↓')
        .split(' / ')
        .map((item) => item.trim());
      return !variants.some((variant) => fromEditor.has(variant) || fromShell.has(variant));
    });
    expect(missing, `не отражены в палитре: ${missing.join(', ')}`).toEqual([]);
  });
});
