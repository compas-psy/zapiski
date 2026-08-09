/**
 * Класс дефектов «состояние держит старый путь».
 *
 * Размножение заметок, которое нашёл пользователь, — не единичный промах, а
 * представитель класса: путь заметки меняется, а состояние приложения
 * продолжает указывать на прежний. Дальше любое действие по этому пути
 * промахивается мимо файла, а `write` вместо промаха создаёт покойника заново.
 *
 * Здесь перечислены ВСЕ места, где путь заметки меняется. Тест написан не по
 * коду, а по списку таких мест: если завтра появится новое, оно обязано
 * появиться и здесь.
 *
 * 1. переименование по заголовку — `rename-follow.test.ts` (закрыто);
 * 2. перемещение в папку;
 * 3. шифрование `.md` → `.md.enc` и снятие шифрования обратно;
 * 4. восстановление из корзины.
 */
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

async function boot(): Promise<AppController> {
  const host = createTestHost({ prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

/** Путь, на который сейчас смотрит приложение. */
function openPath(app: AppController): string | null {
  const route = app.getState().route;
  return route.name === 'note' ? (route as { id: string }).id : null;
}

/** Заводит заметку с заголовком и доводит переименование до конца. */
async function noteTitled(app: AppController, title: string): Promise<string> {
  await app.createNote();
  const born = openPath(app)!;
  await app.save(born, `# ${title}\n\nтекст\n`);
  await app.flushRenamesNow(true);
  return openPath(app)!;
}

describe('состояние следует за путём заметки', () => {
  it('перемещение в папку: маршрут переезжает вместе с файлом', async () => {
    const app = await boot();
    const path = await noteTitled(app, 'Переезд');

    await app.move(path, 'Практика');

    const now = openPath(app);
    expect(now).toBe('Практика/Переезд.md');
    // И следующее сохранение попадает в живой файл, а не плодит новый.
    await app.save(now!, '# Переезд\n\nдописал\n');
    expect(app.getState().notes.filter((n) => n.title === 'Переезд')).toHaveLength(1);
  });

  it('перемещение чужой заметки маршрут не трогает', async () => {
    const app = await boot();
    const other = await noteTitled(app, 'Чужая');
    const mine = await noteTitled(app, 'Своя');

    await app.move(other, 'Практика');

    expect(openPath(app)).toBe(mine);
  });

  it('восстановление из корзины возвращает заметку в список', async () => {
    const app = await boot();
    const path = await noteTitled(app, 'Вернётся');

    await app.trashNote(path);
    expect(app.getState().notes.some((n) => n.title === 'Вернётся')).toBe(false);

    const entry = app.getState().trash.find((item) => item.originalPath.includes('Вернётся'));
    expect(entry, 'запись о заметке должна быть в корзине').toBeTruthy();
    await app.restoreFromTrash(entry!.id);

    const back = app.getState().notes.filter((n) => n.title === 'Вернётся');
    expect(back).toHaveLength(1);
  });

  it('после сохранения в новую папку старого файла не остаётся', async () => {
    const app = await boot();
    const path = await noteTitled(app, 'Один');

    await app.move(path, 'Папка');
    await app.save(openPath(app)!, '# Один\n\nещё текст\n');
    await app.flushRenamesNow(true);

    expect(await app.vaultRef!.storage.read('Один.md')).toBeNull();
    expect(app.getState().notes.filter((n) => n.title === 'Один')).toHaveLength(1);
  });
});

/**
 * Ловушка, в которую я попал, когда чинил размножение.
 *
 * Первая версия правки слепо проводила путь сохранения через карту переездов.
 * Но «Без названия.md» — имя ПОВТОРНО ИСПОЛЬЗУЕМОЕ: следующая новая заметка
 * рождается с ним же. Слепая подстановка отправила её текст в файл предыдущей
 * заметки и затёрла чужое содержимое — то есть лекарство оказалось опаснее
 * болезни.
 *
 * Правило, которое из этого следует: существующий файл всегда главнее карты.
 * Карта отвечает только на вопрос «куда делся файл, которого больше нет».
 */
describe('переиспользуемое имя не уводит запись в чужой файл', () => {
  it('вторая новая заметка не затирает первую', async () => {
    const app = await boot();

    const first = await noteTitled(app, 'Первая');
    const second = await noteTitled(app, 'Вторая');

    expect(first).toBe('Первая.md');
    expect(second).toBe('Вторая.md');

    // Обе заметки на месте, и каждая со своим текстом.
    const bodies = await Promise.all([
      app.vaultRef!.read('Первая.md'),
      app.vaultRef!.read('Вторая.md'),
    ]);
    expect(bodies[0]?.body).toContain('Первая');
    expect(bodies[1]?.body).toContain('Вторая');

    // И никакого «Без названия.md» после себя не осталось.
    const files = (await app.vaultRef!.storage.list('')).map((entry) => entry.path);
    expect(files).not.toContain('Без названия.md');
  });
});
