/**
 * Удаление становится намерением для облака — во всех местах сразу.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «в нашем облаке практически невозможно удалить ЗАПИСКУ, она
 * возвращается при синхронизации через облако. Особенно это подстава для
 * записок, которые только что зашифрованы — если её удалить, то она вернётся
 * из облака незашифрованной, и заверения о том, что всё шифруется, становятся
 * сказкой».
 *
 * `SyncEngine.markDeleted` был написан и его не звал НИ ОДИН файл продукта.
 * Значит удаление никогда не становилось намерением, а движок читает молчание
 * иначе — и правильно: «локально нет, в облаке есть» это заметка с другого
 * устройства, её надо скачать. Поэтому удалённое возвращалось.
 *
 * ── Почему тест перечисляет места списком ───────────────────────────────────
 *
 * Способов «путь исчез» в продукте несколько: корзина, перемещение,
 * переименование по заголовку, шифрование, снятие шифрования. Ровно на этой
 * множественности один раз уже погорело следование за путём — и по той же
 * причине заведён `path-follow.test.ts`. Здесь то же самое, но про облако:
 * добавили новый способ сдвинуть или убрать файл — он обязан появиться в этом
 * списке.
 */
import { describe, expect, it } from 'vitest';

import { ChangeQueue } from '@zapiski/core';
import type { VaultPath } from '@zapiski/core';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const PASSWORD = 'верный пароль';
const FILES = {
  'Работа/Смета.md': '# Смета\n\nчисла по смете\n',
  'Работа/План.md': '# План\n\nпункты\n',
};

/**
 * Контроллер с очередью, в которую можно заглянуть.
 *
 * Очередь берётся настоящая (`ChangeQueue` ядра) и та же самая, что получает
 * движок: проверять подделку здесь бессмысленно — намерение важно ровно тем,
 * что его увидит синхронизация.
 */
async function boot() {
  const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();

  /**
   * Что лежит в очереди НА ДИСКЕ.
   *
   * Читаем не поле контроллера, а `.zapiski/queue.json` — тот самый файл,
   * которым очередь переживает перезапуск (BEHAVIOR §6). Так проверяется не
   * «метод позвали», а «намерение доехало до синхронизации, даже если
   * приложение сейчас закроют».
   */
  const kindOf = async (path: VaultPath): Promise<string | undefined> => {
    /* Намерение ставится без ожидания вызывающим (`void enqueue(...)`) —
       даём микрозадачам дойти до диска. */
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = new ChangeQueue(host.storage);
    await queue.load();
    return queue.list().find((item) => item.path === path)?.kind;
  };

  return { app, host, kindOf };
}

describe('удаление уезжает в облако как намерение', () => {
  it('корзина: путь исчез — облако об этом узнаёт', async () => {
    const { app, kindOf } = await boot();

    await app.trashNote('Работа/Смета.md');

    expect(await kindOf('Работа/Смета.md'), 'корзина не заказала удаление в облаке').toBe('delete');
  });

  it('восстановление из корзины отменяет намерение: путь снова живой', async () => {
    const { app, kindOf } = await boot();
    await app.trashNote('Работа/Смета.md');
    const entry = app.getState().trash[0];
    expect(entry, 'запись корзины не появилась').toBeDefined();

    await app.restoreFromTrash(entry!.id);

    /* На один путь живёт одно намерение, и последнее побеждает: иначе
       восстановленная заметка была бы удалена из облака следующим проходом. */
    expect(await kindOf('Работа/Смета.md')).toBe('put');
  });

  it('шифрование: открытый текст удаляется, контейнер отправляется', async () => {
    /*
     * Самый дорогой случай из письма заказчика. `.md.enc` кладётся рядом,
     * открытый `.md` убирается — и если про второе облако не узнает, оно
     * вернёт открытый текст обратно.
     */
    const { app, kindOf } = await boot();
    await app.setVaultPassword(PASSWORD);

    const target = await app.encryptNote('Работа/Смета.md');

    expect(target).toBe('Работа/Смета.md.enc');
    expect(await kindOf('Работа/Смета.md'), 'открытый текст остался бы в облаке').toBe('delete');
    expect(await kindOf('Работа/Смета.md.enc')).toBe('put');
  });

  it('снятие шифрования: контейнер удаляется, открытая заметка отправляется', async () => {
    const { app, kindOf } = await boot();
    await app.setVaultPassword(PASSWORD);
    const encrypted = await app.encryptNote('Работа/Смета.md');

    const plain = await app.removeEncryption(encrypted!, PASSWORD);

    expect(plain).toBe('Работа/Смета.md');
    expect(await kindOf('Работа/Смета.md.enc'), 'контейнер приехал бы обратно из облака').toBe(
      'delete',
    );
    expect(await kindOf('Работа/Смета.md')).toBe('put');
  });

  it('перемещение в папку: старого пути в облаке быть не должно', async () => {
    const { app, kindOf } = await boot();

    await app.move('Работа/Смета.md', '');

    expect(await kindOf('Работа/Смета.md'), 'старый путь остался бы копией в облаке').toBe('delete');
    expect(await kindOf('Смета.md')).toBe('put');
  });

  it('переименование по заголовку: то же самое', async () => {
    const { app, kindOf } = await boot();

    await app.save('Работа/Смета.md', '# Смета на плитку\n\nчисла по смете\n');
    await app.flushRenamesNow(true);

    expect(await kindOf('Работа/Смета.md')).toBe('delete');
    expect(await kindOf('Работа/Смета на плитку.md')).toBe('put');
  });
});
