/**
 * Открытая заметка обязана следовать за собственным переименованием.
 *
 * Найдено пользователем на живом Windows: «просто набираешь текст, а заметки
 * плодятся автоматически». В списке оказалось пять заметок с одним заголовком
 * «Привет!» и нарастающим числом слов — 1, 8, 10, 13, 13. То есть каждое
 * автосохранение создавало новый файл.
 *
 * Механика такая. Заметка рождается как «Без названия.md». Через две секунды
 * после правки vault переименовывает файл по заголовку (BEHAVIOR §2.2) —
 * получается «Привет!.md». Экран при этом продолжает держать СТАРЫЙ путь, и
 * следующее автосохранение пишет по нему: `write` создаёт файл заново. Дальше
 * цикл повторяется, а поскольку «Привет!.md» уже занят, следующее
 * переименование даёт «Привет! 2.md», и так до бесконечности.
 *
 * Ни один автотест этого не ловил, потому что все они звали `flushRenames`
 * напрямую и не проверяли, куда после этого смотрит приложение.
 */
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

/**
 * Одно «тиканье» таймера переименований — ровно то, что делает оболочка.
 *
 * Именно здесь и была дыра в проверке: прежние тесты звали
 * `vault.flushRenames()` напрямую и потому не видели, куда после этого
 * смотрит приложение. `flushRenamesNow` — тот же код, что крутит таймер.
 */
async function tick(app: AppController): Promise<void> {
  await app.flushRenamesNow(true);
}

describe('заметка следует за переименованием по заголовку', () => {
  async function boot(): Promise<AppController> {
    const host = createTestHost({ prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    return app;
  }

  it('набор текста не плодит заметок', async () => {
    const app = await boot();
    const before = app.getState().notes.length;

    await app.createNote();
    const route = app.getState().route;
    expect(route.name).toBe('note');

    // Пользователь печатает: несколько автосохранений подряд, между ними —
    // тиканье таймера переименований. Ровно то, что было на устройстве.
    const drafts = [
      '# Привет!\n',
      '# Привет!\n\nЯ хотел бы ветром стать\n',
      '# Привет!\n\nЯ хотел бы ветром стать и над землей лететь\n',
      '# Привет!\n\nЯ хотел бы ветром стать и над землей лететь\n\nА кто ты?\n',
    ];
    for (const body of drafts) {
      const current = app.getState().route;
      expect(current.name).toBe('note');
      await app.save((current as { id: string }).id, body);
      await tick(app);
    }

    // Заметка ровно одна, и в ней последняя версия текста.
    expect(app.getState().notes.length).toBe(before + 1);
    const note = app.getState().notes.find((item) => item.title === 'Привет!');
    expect(note, 'заметка с заголовком «Привет!» должна существовать').toBeTruthy();
    expect(note!.wordCount).toBeGreaterThan(8);
  });

  it('маршрут переезжает вместе с файлом', async () => {
    const app = await boot();
    await app.createNote();
    const first = (app.getState().route as { id: string }).id;

    await app.save(first, '# Заголовок\n\nтекст\n');
    await tick(app);

    const after = app.getState().route;
    expect(after.name).toBe('note');
    const path = (after as { id: string }).id;
    expect(path).not.toBe(first);
    expect(path).toBe('Заголовок.md');

    // И по новому пути лежит именно наш текст, а старого файла больше нет.
    expect(await app.vaultRef!.storage.read('Заголовок.md')).toBeTruthy();
    expect(await app.vaultRef!.storage.read(first)).toBeNull();
  });

  it('переименование чужой заметки маршрут не трогает', async () => {
    const app = await boot();

    await app.createNote();
    const other = (app.getState().route as { id: string }).id;
    await app.save(other, '# Чужая\n\nтекст\n');
    await tick(app);

    await app.createNote();
    const mine = (app.getState().route as { id: string }).id;

    // Правим чужую заметку, не открывая её: маршрут обязан остаться на своей.
    await app.save('Чужая.md', '# Переехала\n\nтекст\n');
    await tick(app);

    expect((app.getState().route as { id: string }).id).toBe(mine);
  });
});
