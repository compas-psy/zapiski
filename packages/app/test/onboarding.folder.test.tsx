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

    await expect(app.openVault(unopenableStorage())).rejects.toThrow();

    // Состояние обязано говорить правду о себе: vault не открыт, загрузка
    // закончилась. Иначе вызывающий не может ни показать ошибку, ни
    // предложить другое место — экран просто замирает.
    expect(app.getState().booting).toBe(false);
    expect(app.getState().ready).toBe(false);
  });

  it('после отказа работа продолжается в памяти, а не упирается в тупик', async () => {
    const toasts: string[] = [];
    const host = createTestHost({ prefs: { onboarded: false } });
    const app = new AppController(host, (toast) => toasts.push(toast.message));

    // Ровно та последовательность, что делает экран: попытка, отказ,
    // сообщение реестра, переход в память, первая заметка.
    await app.openVault(unopenableStorage()).catch(() => {
      app.toast({ message: ru.errors.folderUnavailable });
    });
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
