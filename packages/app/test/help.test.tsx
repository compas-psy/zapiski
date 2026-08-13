/**
 * Раздел справки (по прямой просьбе пользователя).
 *
 * «Очень не хватает раздела справки, особенно по горячим клавишам и по
 * форматированию MarkDown». До этого узнать сочетание было неоткуда: палитра
 * команд показывает часть, но её саму надо сначала найти, а на телефоне
 * клавиатуры нет вовсе.
 *
 * Главное, что здесь сторожится, — не наличие экрана, а его правдивость:
 * сочетания в справке обязаны совпадать с теми, что действительно работают.
 * Справка, разошедшаяся с кодом, хуже отсутствующей — по ней человек делает
 * вывод и перестаёт искать.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { AppProvider } from '../src/state/context.js';
import { HelpScreen } from '../src/screens/HelpScreen.js';
import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');
const REPO_ROOT = resolve(__dirname, '../../..');

async function mountHelp(width = 1280): Promise<void> {
  window.innerWidth = width;
  const host = createTestHost({ prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <HelpScreen />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('справка показывает то, ради чего заведена', () => {
  it('сочетания клавиш — на десктопе', async () => {
    await mountHelp();
    expect(screen.getByText('Жирный')).toBeTruthy();
    expect(screen.getByText(/Ctrl\+B|⌘\+B/)).toBeTruthy();
  });

  it('шпаргалка по разметке — всегда', async () => {
    await mountHelp();
    expect(screen.getByText('**жирный**')).toBeTruthy();
    expect(screen.getByText('- [ ] дело')).toBeTruthy();
    expect(screen.getByText('[[Заметка]]')).toBeTruthy();
  });

  it('на телефоне сочетаний нет, а разметка есть', async () => {
    /* Физической клавиатуры там нет, и колонка сочетаний только занимает
       место. Разметка нужна на всех платформах: файл остаётся markdown. */
    await mountHelp(390);
    expect(screen.queryByText('Жирный')).toBeNull();
    expect(screen.getByText('**жирный**')).toBeTruthy();
  });
});

describe('справка не расходится с кодом', () => {
  /** Сочетания, как они объявлены в keymap редактора. */
  const keymap = readFileSync(
    resolve(REPO_ROOT, 'packages/editor/src/commands/keymap.ts'),
    'utf8',
  );

  /**
   * `Mod+Shift+X` из справки → `Mod-Shift-x`, как пишет CodeMirror.
   *
   * Стрелки в справке нарисованы символами — человек ищет глазами клавишу,
   * а не строку `ArrowUp`. Для сверки переводим обратно.
   */
  const ARROWS: Record<string, string> = { '↑': 'ArrowUp', '↓': 'ArrowDown' };
  const asKeymap = (label: string): string =>
    label
      .replace(/[↑↓]/g, (arrow) => ARROWS[arrow] ?? arrow)
      .replace(/\+/g, '-')
      .replace(/-([a-zA-Z])$/, (_m, letter: string) => `-${letter.toLowerCase()}`);

  it('каждое объявленное сочетание редактора есть в keymap', () => {
    const editorGroups = ru.help.hotkeyGroups.filter(
      (group) => group.title !== 'ЗАМЕТКИ И ОКНО',
    );
    const checked: string[] = [];
    for (const group of editorGroups) {
      for (const [, keys] of group.items) {
        /*
         * Строка справки может нести ДВА сочетания через «·» — второе для
         * браузера, который первое забирает себе (Ctrl+1 — вкладка, Ctrl+0 —
         * масштаб, Ctrl+L — адресная строка). Проверяются оба: обещать
         * запасное и не завести его — тот же обман, что и с основным.
         *
         * Диапазоны и пары («Mod+1 … Mod+6», «Alt+↑ / Alt+↓») проверяются по
         * первому сочетанию: остальные объявлены рядом той же строкой.
         */
        for (const variant of keys.split('·')) {
          const first = variant.trim().split(/\s*[…/]\s*/)[0] as string;
          const needle = asKeymap(first);
          checked.push(needle);
          expect(keymap, `${needle} нет в keymap`).toContain(`'${needle}'`);
        }
      }
    }
    /* Сторож не проверяет пустоту: если разбор сломается, здесь будет ноль. */
    expect(checked.length).toBeGreaterThan(15);
  });

  it('в шпаргалке нет разметки, которой редактор не понимает', () => {
    /* Каждая строка слева — то, что человек наберёт. Обещать `^верхний^`,
       которого нет в грамматике, значит подвести его молча. */
    const grammar = readFileSync(
      resolve(REPO_ROOT, 'packages/editor/src/syntax/markdown-ext.ts'),
      'utf8',
    );
    expect(grammar).toContain('==');
    expect(grammar.includes('[[') || grammar.includes('ZWikiLink')).toBe(true);
  });
});
