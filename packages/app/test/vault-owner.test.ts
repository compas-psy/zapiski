/**
 * Смена учётки: данные не перемешиваются и не пропадают.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Хранилище было одно и об аккаунте не знало. `signOutCloud` отцеплял синк, но
 * папку оставлял; вход второй учёткой цеплял облако к ТОЙ ЖЕ папке. Дальше
 * движок делал то, для чего он есть, — отправлял всё, что видит. То есть
 * заметки первого человека уезжали в облако второго.
 *
 * Заказчик описал видимую половину: «данные уже хранятся рядом и
 * перемешиваются». Невидимая половина хуже: чужие заметки покидали устройство.
 *
 * ── Что проверяется ─────────────────────────────────────────────────────────
 *
 * Модель Obsidian: хранилище — папка владельца, смена личности означает смену
 * папки. Заметки прежнего владельца остаются на диске и возвращаются, когда он
 * возвращается. Порядок «досылка → отцепление → открытие чужого» обязателен:
 * наоборот — это отправка чужих файлов.
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const FILES = { 'Первая.md': '# Первая\n\nзаметка первого хозяина\n' };

async function boot(): Promise<{
  app: AppController;
  host: ReturnType<typeof createTestHost>;
}> {
  const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return { app, host };
}

describe('хранилище принадлежит владельцу', () => {
  it('без аккаунта владелец — «local»', async () => {
    const { app } = await boot();
    expect(app.owner()).toBe('local');
  });

  it('почта нормализуется: регистр и пробелы не заводят второе место', async () => {
    const { app } = await boot();
    app.setAccount({ email: '  Ivan@Ya.RU ', plan: 'free', marketingOptIn: false });
    expect(app.owner()).toBe('ivan@ya.ru');
  });
});

describe('вход другой учёткой не показывает чужие заметки', () => {
  it('новая учётка получает своё место, старая — своё', async () => {
    const { app } = await boot();
    expect(app.getState().notes.map((note) => note.path)).toContain('Первая.md');

    /* Вход второй учёткой: место открывается ЕЁ, а не предыдущее. */
    app.setAccount({ email: 'second@ya.ru', plan: 'free', marketingOptIn: false });
    await app.switchOwnerForTest();
    expect(app.getState().notes).toHaveLength(0);

    /* Своя заметка второго хозяина. */
    await app.createNote();
    expect(app.getState().notes).toHaveLength(1);

    /* Возврат к первому: его заметки на месте, чужой среди них нет. */
    app.setAccount(null);
    await app.switchOwnerForTest();
    const paths = app.getState().notes.map((note) => note.path);
    expect(paths).toContain('Первая.md');
    expect(paths).toHaveLength(1);
  });

  it('заметки прежнего владельца не удаляются, а ждут его', async () => {
    const { app, host } = await boot();
    app.setAccount({ email: 'second@ya.ru', plan: 'free', marketingOptIn: false });
    await app.switchOwnerForTest();

    /* Файл первого хозяина лежит на своём месте нетронутым. */
    expect(await host.storage.read('Первая.md')).not.toBeNull();
  });
});

describe('чужие заметки не уезжают в чужое облако', () => {
  /**
   * Невидимая половина дефекта, и она серьёзнее видимой.
   *
   * Движок синхронизации отправляет то, что видит в открытом хранилище. Пока
   * хранилище было общим, вход второй учёткой означал: «облако второго
   * человека, папка первого» — и первая же отправка уносила чужие заметки.
   *
   * Отсюда порядок в `switchOwner`, который здесь и проверяется: сначала
   * досылаем накопленное СТАРЫМ бэкендом, потом отцепляем его, и только потом
   * открываем чужое место. Переставить эти шаги — значит отправить чужое.
   */
  it('к моменту открытия чужого хранилища бэкенд отцеплен', async () => {
    const { app } = await boot();

    const seen: Array<{ owner: string; backend: string | null }> = [];
    const host = app.host as unknown as { restoreVault: (owner?: string) => Promise<unknown> };
    const original = host.restoreVault.bind(host);
    host.restoreVault = async (owner?: string) => {
      seen.push({ owner: owner ?? 'local', backend: app.getState().backendId });
      return original(owner);
    };

    app.attachBackend({
      id: 'zapiski',
      async list() {
        return [];
      },
      async read() {
        return null;
      },
      async write() {
        return { rev: '1' };
      },
      async remove() {},
    } as never);
    expect(app.getState().backendId).toBe('zapiski');

    app.setAccount({ email: 'second@ya.ru', plan: 'free', marketingOptIn: false });
    await app.switchOwnerForTest();

    const opening = seen.at(-1);
    expect(opening?.owner).toBe('second@ya.ru');
    /* Ключевое утверждение: чужое место открывается уже БЕЗ облака прежнего. */
    expect(opening?.backend).toBeNull();
  });
});
