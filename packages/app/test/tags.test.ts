/**
 * Переименование тега (BEHAVIOR §3).
 *
 * «Дерево тегов строится из текстов заметок и не редактируется напрямую:
 * переименование тега выполняет замену во всех заметках — ОО с тостом
 * „Переименовано в N заметках · Отменить“».
 *
 * Проверяется именно текст на диске: тег живёт в теле заметки, и любая замена,
 * которая «работает» только в индексе, — это потеря данных при следующем
 * пересборе.
 */
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

async function boot(files: Record<string, string>): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

/**
 * Читаем БАЙТЫ с диска и раскодируем сами, а не спрашиваем разобранную заметку
 * у хранилища: замена тега обязана попасть в файл, а не только в индекс.
 * Индекс переживёт перезапуск, файл — нет, если в него не записали.
 */
const read = async (app: AppController, path: string): Promise<string> => {
  const bytes = await app.vaultRef!.storage.read(path);
  return bytes === null ? '' : new TextDecoder().decode(bytes);
};

describe('переименование тега', () => {
  it('меняет тег во всех заметках и возвращает их число', async () => {
    const app = await boot({
      'Одна.md': '# Одна\n\n#практика тут\n',
      'Две.md': '# Две\n\nи тут #практика\n',
      'Три.md': '# Три\n\nтут без тега\n',
    });

    const changed = await app.renameTag('практика', 'работа');

    expect(changed).toBe(2);
    expect(await read(app, 'Одна.md')).toContain('#работа');
    expect(await read(app, 'Две.md')).toContain('#работа');
    expect(await read(app, 'Одна.md')).not.toContain('#практика');
    expect(await read(app, 'Три.md')).toContain('без тега');
  });

  it('вложенные теги переезжают вместе с корнем', async () => {
    const app = await boot({ 'Одна.md': '# Одна\n\n#практика/супервизия здесь\n' });

    await app.renameTag('практика', 'работа');

    // Человек переименовал корень и ждёт, что ветка поедет за ним, а не
    // осиротеет под старым именем.
    expect(await read(app, 'Одна.md')).toContain('#работа/супервизия');
  });

  it('не задевает тег, который лишь начинается так же', async () => {
    const app = await boot({ 'Одна.md': '# Одна\n\n#практикант и #практика\n' });

    await app.renameTag('практика', 'работа');

    const body = await read(app, 'Одна.md');
    expect(body).toContain('#практикант');
    expect(body).toContain('#работа');
  });

  it('«Отменить» возвращает прежний тег во все заметки', async () => {
    const toasts: Array<{ message: string; onAction?: () => void | Promise<void> }> = [];
    const host = createTestHost({
      files: { 'Одна.md': '# Одна\n\n#практика тут\n' },
      prefs: { onboarded: true },
    });
    const app = new AppController(host);
    app.setToastSink((toast) => toasts.push(toast));
    await app.boot();

    await app.renameTag('практика', 'работа');
    const undo = toasts.find((toast) => toast.onAction);
    expect(undo?.message).toContain('1');

    await undo!.onAction!();

    expect(await read(app, 'Одна.md')).toContain('#практика');
  });

  it('несуществующий тег ничего не меняет и не поднимает тост', async () => {
    const app = await boot({ 'Одна.md': '# Одна\n\n#практика тут\n' });
    // «Переименовано в 0 заметках» — сообщение, которое ничего не сообщает.
    expect(await app.renameTag('досуг', 'отдых')).toBe(0);
    expect(await read(app, 'Одна.md')).toContain('#практика');
  });

  it('открытый фильтр переезжает на новый тег, а не показывает пустоту', async () => {
    const app = await boot({ 'Одна.md': '# Одна\n\n#практика тут\n' });
    app.openTag('практика');

    await app.renameTag('практика', 'работа');

    expect(app.getState().tag).toBe('работа');
    expect(app.getState().notes).toHaveLength(1);
  });
});
