/**
 * Сторож §3: объявленная настройка обязана что-то делать.
 *
 * Жалоба пользователя звучала узко — «изменение ширины редактора не работает».
 * Причина оказалась шире: проп `typography` не передавался редактору НИГДЕ, и
 * CodeMirror всегда жил на значениях по умолчанию. Мёртвыми были разом пять
 * настроек — кегль, интерлиньяж, ширина колонки, шрифт и компактный режим.
 *
 * Обманывало то, что снаружи всё выглядело подключённым: `applyAppearance`
 * честно писал `--editor-measure` и `--editor-font-scale` на корень документа,
 * и обёртка колонки их слушалась. Но текст рисует CodeMirror, а ширину он
 * берёт из своей переменной `--z-col`. Менялась рамка вокруг пустоты.
 *
 * Отсюда форма проверки: не «настройка сохранилась», а «значение доехало до
 * элемента, который рисует текст».
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThemeProvider, ToastProvider, type EditorPreferences } from '@zapiski/ui';
import { AppProvider } from '../src/state/context.js';
import { NoteScreen } from '../src/screens/NoteScreen.js';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const FILES = { 'Заметка.md': '# Заметка\n\nтекст\n' };

async function mountWith(editor: Partial<EditorPreferences>) {
  const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider
      persist={false}
      initial={{
        theme: 'paper',
        accent: 'garnet',
        editor: {
          fontSize: 16,
          lineHeight: 1.65,
          columnWidth: 640,
          typeface: 'sans',
          compact: false,
          typewriter: false,
          moveDone: false,
          spellcheck: false,
          ...editor,
        },
      }}
    >
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <NoteScreen path="Заметка.md" />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  await screen.findByRole('textbox', { name: 'Название заметки' });
  const editorRoot = document.querySelector<HTMLElement>('.cm-editor');
  expect(editorRoot, 'редактор не смонтировался').not.toBeNull();
  return editorRoot as HTMLElement;
}

/** Значение переменной из инлайн-стиля редактора — там их и ставит типографика. */
function cssVar(element: HTMLElement, name: string): string {
  return element.style.getPropertyValue(name).trim();
}

describe('настройки внешнего вида доезжают до текста (ITERATION-1 §3)', () => {
  it('ширина колонки — главный пример из письма', async () => {
    expect(cssVar(await mountWith({ columnWidth: 640 }), '--z-col')).toBe('640px');
  });

  it('«вся ширина» снимает ограничение, а не ставит большое число', async () => {
    expect(cssVar(await mountWith({ columnWidth: 'full' }), '--z-col')).toBe('none');
  });

  it('другая ширина даёт другое значение', async () => {
    expect(cssVar(await mountWith({ columnWidth: 720 }), '--z-col')).toBe('720px');
  });

  it('кегль', async () => {
    expect(cssVar(await mountWith({ fontSize: 20 }), '--z-fs')).toBe('20.00px');
  });

  it('интерлиньяж', async () => {
    expect(cssVar(await mountWith({ lineHeight: 1.85 }), '--z-lh')).toBe('1.850');
  });

  it('шрифт с засечками', async () => {
    /* Serif по токенам на шаг крупнее — 16 → 17 (DESIGN_TOKENS §2). */
    const root = await mountWith({ typeface: 'serif' });
    expect(cssVar(root, '--z-face')).toContain('Source Serif');
    expect(cssVar(root, '--z-fs')).toBe('17.00px');
  });

  it('компактный режим ужимает и текст, и поля', async () => {
    const root = await mountWith({ compact: true });
    expect(Number.parseFloat(cssVar(root, '--z-fs'))).toBeLessThan(16);
    expect(cssVar(root, '--z-pad-y')).toBe('24px');
  });
});

describe('настройки редактора перестали быть декорацией', () => {
  it('проверка орфографии доходит до contenteditable', async () => {
    await mountWith({ spellcheck: true });
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('.cm-content')?.spellcheck).toBe(true);
    });
  });

  it('без настройки орфография выключена', async () => {
    await mountWith({ spellcheck: false });
    await waitFor(() => {
      expect(document.querySelector<HTMLElement>('.cm-content')?.spellcheck).toBe(false);
    });
  });
});
