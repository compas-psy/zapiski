/**
 * Пустые «Без названия» не плодятся.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «очень бесит один момент: когда нажал „Новая заметка“ → происходит
 * автосохранение → в заметку ничего не вносится совсем → количество заметок
 * „Без названия 2“ плодится».
 *
 * Так и было. «Плюс» сразу создавал файл, автосохранение его записывало, и
 * каждое случайное нажатие оставляло в списке ещё одну безымянную пустышку.
 * Хуже: пустышка попадала в очередь отправки и уезжала в облако, а оттуда — на
 * второе устройство, где её тоже надо было убирать руками.
 *
 * ── Правило, которое здесь сторожится ───────────────────────────────────────
 *
 * Заметка, созданную которую не тронули ни одним знаком, не переживает уход с
 * экрана. Три условия вместе: создана в этом сеансе нашим «плюсом», без имени
 * («Без названия» подставили мы, а не человек), тело пустое. Всё остальное —
 * неприкосновенно: написанное убирают только через корзину.
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { ChangeQueue } from '@zapiski/core';
import { createTestHost } from './host.js';

async function boot(files: Record<string, string> = {}) {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return { app, host };
}

const untitledCount = (app: AppController): number =>
  app.getState().notes.filter((note) => note.title.startsWith('Без названия')).length;

describe('пустая новая заметка не остаётся в списке', () => {
  it('три нажатия «Новая заметка» не оставляют трёх пустышек', async () => {
    const { app } = await boot();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const path = await app.createNote();
      expect(path, 'заметка не создалась').not.toBeNull();
      /* Уход со экрана заметки — то же, что «назад» или открытие другой. */
      app.navigate({ name: 'list' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(untitledCount(app), 'безымянные пустышки накопились').toBe(0);
    expect(app.getState().notes.length).toBe(0);
  });

  it('пустышка не уезжает в облако: намерение снято', async () => {
    const { app, host } = await boot();
    const path = await app.createNote();

    app.navigate({ name: 'list' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const queue = new ChangeQueue(host.storage);
    await queue.load();
    expect(
      queue.list().some((item) => item.path === path),
      'пустая заметка осталась в очереди отправки',
    ).toBe(false);
  });

  it('написали хоть знак — заметка остаётся', async () => {
    const { app } = await boot();
    const path = await app.createNote();

    await app.save(path!, 'мысль на ходу');
    app.navigate({ name: 'list' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getState().notes.length, 'написанное исчезло — это потеря текста').toBe(1);
  });

  it('чужая пустая заметка не трогается', async () => {
    /*
     * Предохранитель. Пустой файл мог появиться откуда угодно: синхронизация,
     * импорт, чужой редактор. Мы удаляем ТОЛЬКО то, что создали сами в этом
     * сеансе и во что человек не написал ни знака.
     */
    const { app } = await boot({ 'Без названия.md': '' });
    expect(app.getState().notes.length).toBe(1);

    app.openNote('Без названия.md');
    app.navigate({ name: 'list' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getState().notes.length, 'удалили файл, которого не создавали').toBe(1);
  });

  it('заметка с заголовком остаётся даже с пустым телом', async () => {
    /* «Новая заметка в текущей папке» с именем — это уже решение человека:
       он назвал заметку, значит она ему нужна. */
    const { app } = await boot();
    const path = await app.createNote(undefined, 'Созвон в пятницу');

    app.navigate({ name: 'list' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(app.getState().notes.some((note) => note.path === path)).toBe(true);
  });
});
