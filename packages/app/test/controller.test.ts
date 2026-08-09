/**
 * Поведение контроллера: поиск, шифрование, оффлайн, состояния экранов.
 * Всё, что здесь проверяется, живёт в `packages/app` и одинаково работает
 * в вебе, на Windows и на Android (ARCHITECTURE §1).
 */
import { unlockDelayMs } from '@zapiski/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const NOTES = {
  'Заметки/Первая.md': '# Первая\n\nТекст про практику #практика\n',
  'Заметки/Вторая.md': '# Вторая\n\nЕщё текст про супервизию #практика/супервизия\n',
  'Третья.md': '# Третья\n\nСовсем другое\n',
};

async function boot(files = NOTES): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

afterEach(() => vi.useRealTimers());

describe('поиск — BEHAVIOR §4', () => {
  it('результаты обновляются с задержкой 120 мс, не раньше', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setQuery('практику');
    expect(app.getState().results).toHaveLength(0);
    vi.advanceTimersByTime(119);
    expect(app.getState().results).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(app.getState().results.length).toBeGreaterThan(0);
    app.dispose();
  });

  it('запрос короче двух символов не ищет', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setQuery('п');
    vi.advanceTimersByTime(200);
    expect(app.getState().results).toHaveLength(0);
    app.dispose();
  });

  it('оператор в строке ищет и без текста — чипы и строка синхронны', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setQuery('tag:практика');
    vi.advanceTimersByTime(120);
    expect(app.getState().results.length).toBeGreaterThan(0);
    app.dispose();
  });

  it('недавние запросы копятся до восьми, без повторов', async () => {
    const app = await boot();
    for (const query of ['a', 'b', 'c', 'a']) app.rememberQuery(query);
    expect(app.getState().recentQueries.slice(0, 3)).toEqual(['a', 'c', 'b']);
    app.dispose();
  });
});

describe('задержки после неудачных попыток — BEHAVIOR §5.2', () => {
  it('1–4 попытки без задержки, 5-я — 30 с, 8-я — 5 мин', () => {
    expect(unlockDelayMs(1)).toBe(0);
    expect(unlockDelayMs(4)).toBe(0);
    expect(unlockDelayMs(5)).toBe(30_000);
    expect(unlockDelayMs(8)).toBe(300_000);
  });

  it('заметки при этом не удаляются и устройство не блокируется', async () => {
    const app = await boot();
    const before = app.getState().notes.length;
    /* Пробуем «разблокировать» обычную заметку — пароль не подойдёт. */
    const result = await app.unlock('Третья.md', 'неверный');
    expect(result).toBeNull();
    expect(app.getState().notes).toHaveLength(before);
    app.dispose();
  });
});

describe('оффлайн — нормальный режим, а не сбой', () => {
  it('состояние списка становится «оффлайн», ввод ничем не блокируется', async () => {
    const app = await boot();
    app.setOnline(false);
    expect(app.screenState('list', false)).toBe('offline');
    /* Заметку по-прежнему можно записать. */
    await app.save('Третья.md', '# Третья\n\nдописали оффлайн\n');
    const note = await app.readNote('Третья.md');
    expect(note?.body).toContain('дописали оффлайн');
    app.dispose();
  });

  it('ошибка синка живёт в статусе и не превращается в модалку', async () => {
    const app = await boot();
    app.reportError('Не удалось синхронизировать · Повторить');
    expect(app.getState().syncError).toBe('Не удалось синхронизировать · Повторить');
    expect(app.getState().sync.state).toBe('error');
    expect(app.screenState('list', false)).toBe('error');
    app.dispose();
  });
});

describe('отладочное меню воспроизводит матрицу §12 — критерий №10', () => {
  it('принудительное состояние показывается там, где ячейка заполнена', async () => {
    const app = await boot();
    app.setDebug({ forceState: 'locked' });
    expect(app.screenState('list', false)).toBe('locked');
    /* У «Папка/тег» ячейки «Заперто» в таблице нет — прочерк. */
    expect(app.screenState('folder', false)).toBe('normal');
    app.setDebug({ forceState: null });
    expect(app.screenState('list', false)).toBe('normal');
    app.dispose();
  });
});

describe('сортировка запоминается на папку, а не глобально — BEHAVIOR §1.2', () => {
  it('смена режима в одной папке не трогает другую', async () => {
    const app = await boot();
    app.setSortMode('Заметки', 'title');
    expect(app.sortModeFor('Заметки')).toBe('title');
    expect(app.sortModeFor(null)).toBe('updated');
    app.dispose();
  });
});

describe('экспорт — BEHAVIOR §9', () => {
  it('отдаёт файл платформе; PDF без порта печати недоступен', async () => {
    const host = createTestHost({ files: NOTES, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();

    await app.exportNoteAs('Третья.md', 'md');
    expect(host.saved.at(-1)?.mime).toBe('text/markdown');

    await app.exportNoteAs('Третья.md', 'pdf');
    /* `pdf: null` — печатать нечем, файл не появляется (элемент СКРЫТ в UI). */
    expect(host.saved).toHaveLength(1);

    await app.exportAll();
    expect(host.saved.at(-1)?.name).toBe('zapiski.zip');
    app.dispose();
  });
});
