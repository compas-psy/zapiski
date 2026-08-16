/**
 * Онбординг, шаг 2: папку выбрали, а открыть её не вышло.
 *
 * Реальный случай с устройства: Samsung Internet, тап по «Дальше», системный
 * выбор папки, «Использовать эту папку» — и снова тот же экран, без единого
 * слова. Приложение выглядело сломанным, хотя ошибка была ровно одна и
 * поправимая.
 *
 * Причин у отказа много и все они снаружи одинаковы: провайдер не дал прав,
 * папка исчезла, браузер не умеет нужный вызов. Общее требование одно —
 * BEHAVIOR §11 и приёмочный критерий C5: ошибка **не блокирует ввод** и
 * называется словами из реестра. Молчаливый возврат на тот же экран нарушает
 * оба: человек не знает ни что случилось, ни что делать.
 *
 * Здесь проверяется договор на отказ: сообщение реестра показано, а работа
 * продолжается — заметки пишутся сразу, это local-first.
 */
import { catalog, type VaultStorage } from '@zapiski/core';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const ru = catalog('ru');

/**
 * Папка, которую система отдала, но писать в неё не даёт.
 *
 * Именно так ведут себя провайдеры Android: диалог выбора закончился успешно,
 * а первое же обращение отвечает `NotAllowedError`.
 */
function unopenableStorage(): VaultStorage {
  const refuse = (): Promise<never> =>
    Promise.reject(new DOMException('доступ к папке не выдан', 'NotAllowedError'));
  return {
    read: refuse,
    write: refuse,
    remove: refuse,
    rename: refuse,
    list: refuse,
    stat: refuse,
    mkdir: refuse,
  };
}

describe('онбординг: выбранная папка не открылась', () => {
  it('openVault не оставляет состояние в «загружаюсь»', async () => {
    const host = createTestHost({ prefs: { onboarded: false } });
    const app = new AppController(host);

    /* Раньше здесь ждали исключения. Теперь `openVault` не бросает НИКОГДА и
       возвращает исход: «Папка недоступна» обязана иметь ровно один источник,
       а исключение внутри — это дюжина источников, каждый из которых
       вызывающий читает как пропавшую папку. */
    expect(await app.openVault(unopenableStorage())).toBe('unreadable');

    // Состояние обязано говорить правду о себе: загрузка закончилась. Иначе
    // вызывающий не может ни показать ошибку, ни предложить другое место —
    // экран просто замирает.
    expect(app.getState().booting).toBe(false);
  });

  it('после отказа работа продолжается в памяти, а не упирается в тупик', async () => {
    const toasts: string[] = [];
    const host = createTestHost({ prefs: { onboarded: false } });
    const app = new AppController(host, (toast) => toasts.push(toast.message));

    // Ровно та последовательность, что делает экран: попытка, отказ,
    // сообщение реестра, переход в память, первая заметка.
    if ((await app.openVault(unopenableStorage())) === 'unreadable') {
      app.toast({ message: ru.errors.folderUnavailable });
    }
    await app.openMemoryVault();
    await app.createNote();

    expect(toasts).toContain(ru.errors.folderUnavailable);
    expect(app.getState().ready).toBe(true);
    expect(app.getState().notes.length).toBeGreaterThan(0);
  });

  it('текст берётся из реестра §11 дословно, а не пишется заново', () => {
    expect(ru.errors.folderUnavailable).toBe(
      'Папка недоступна. Возможно, её переместили — укажите новое расположение',
    );
  });
});

/**
 * «Папка недоступна» имеет ровно один источник — и это правило сторожится.
 *
 * ── Цена нарушения ──────────────────────────────────────────────────────────
 *
 * Заказчик прошёл через это четыре раза подряд: выбирал системным окном свою
 * папку и получал «Папка недоступна» о папке, которая лежала на месте. Каждый
 * раз ломалось РАЗНОЕ — доигрывание прерванного переименования, чтение очереди
 * неотправленного, подъём облака, запись настройки, — а сообщение было одно, и
 * по нему нельзя было отличить одну беду от другой.
 *
 * Правило: `openVault` не бросает никогда. Что бы ни сломалось внутри после
 * того, как хранилище открылось, наружу выходит `ok`. `unreadable` означает
 * ровно одно: прочитать хранилище не удалось.
 */
describe('открытие хранилища не бросает никогда', () => {
  it('поломка ПОСЛЕ открытия не превращается в «папка недоступна»', async () => {
    const host = createTestHost({ files: { 'Заметка.md': '# Заметка\n' }, prefs: { onboarded: true } });
    const app = new AppController(host);
    /* Ломаем то, что идёт после открытия: очередь неотправленного лежит в том
       же хранилище и читается сразу за vault'ом. */
    const storage = host.storage;
    const read = storage.read.bind(storage);
    storage.read = async (path) => {
      if (path.includes('.zapiski')) throw new Error('мост отказал на служебном файле');
      return read(path);
    };

    const outcome = await app.openVault(storage);

    expect(outcome, 'поломка после открытия выдана за пропавшую папку').toBe('ok');
    expect(app.getState().notes.map((note) => note.path)).toContain('Заметка.md');
  });
});
