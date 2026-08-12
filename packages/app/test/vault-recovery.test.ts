/**
 * Что происходит, когда до папки с заметками не достучаться.
 *
 * Отзыв заказчика: «при переключении темы сбрасываются заметки и невозможно
 * создать новую». Заметки при этом никуда не девались — приложение просто
 * перестало знать, где они лежат, и не сказало об этом ни слова.
 *
 * Правило, которое здесь сторожится: **отказ обязан быть громким и
 * обратимым**. Пустой список — это утверждение «у вас нет заметок», и оно
 * ложное. Молчаливый отказ создать заметку — то же самое про кнопку.
 */
import { describe, expect, it, vi } from 'vitest';

import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

describe('хранилище недоступно', () => {
  it('создание заметки говорит, а не молчит', async () => {
    /* `restoreVault`, вернувший null, — это «сейчас не знаю, где заметки».
       Раньше `createNote` в этом случае возвращал null без единого слова:
       человек жал «плюс», ничего не происходило, и вывод делался про всё
       приложение сразу. */
    const host = createTestHost({ prefs: { onboarded: true } });
    host.restoreVault = async () => null;

    const app = new AppController(host);
    const toasts: string[] = [];
    app.setToastSink((toast) => toasts.push(toast.message));
    await app.boot();

    expect(await app.createNote()).toBeNull();
    expect(toasts).toContain(ru.errors.folderUnavailable);
  });

  it('текст берётся из реестра ядра, а не сочиняется на месте', () => {
    /* Реестр §11 — единственный источник формулировок; своя копия рано или
       поздно разойдётся с ним по букве. */
    expect(ru.errors.folderUnavailable).toContain('Папка недоступна');
  });
});

describe('повторная загрузка не запускается дважды', () => {
  it('два вызова boot() дают один прогон', async () => {
    /* Провайдер зовёт `boot()` на монтировании, а оболочка может перезагрузить
       страницу. Два наложившихся прогона гонялись за `this.vault` и заводили по
       своему набору таймеров — таймеры проигравшего не останавливал никто. */
    const host = createTestHost({ prefs: { onboarded: true } });
    const restore = vi.fn(host.restoreVault.bind(host));
    host.restoreVault = restore;

    const app = new AppController(host);
    await Promise.all([app.boot(), app.boot()]);

    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('следующий boot() после завершённого — снова работает', async () => {
    /* Защита не должна превратиться в «загрузиться можно только раз»:
       смена папки открывает хранилище заново. */
    const host = createTestHost({ prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    await app.boot();
    expect(app.vaultRef).not.toBeNull();
  });
});

describe('настройка не легла на диск', () => {
  it('отказ записи слышен, а не теряется', async () => {
    /* Раньше это писалось как `void this.host.prefs.set(...)`: отказ
       становился unhandled rejection, переключатель показывал новое значение,
       а на диск не ложилось ничего. Человек узнавал об этом при следующем
       запуске — настройка возвращалась к прежней сама. */
    const host = createTestHost({ prefs: { onboarded: true } });
    /* Отказ точечный: `boot()` сам пишет настройки, и «ломать всё» значило бы
       проверять запуск, а не запись настройки. */
    const honest = host.prefs.set.bind(host.prefs);
    host.prefs.set = async (key, value) => {
      if (key === 'security.autoLockMinutes') throw new Error('диск не отвечает');
      await honest(key, value);
    };

    const app = new AppController(host);
    const toasts: string[] = [];
    app.setToastSink((toast) => toasts.push(toast.message));
    await app.boot();

    /* Настройка выбрана нарочно не языковая: `setLocale` успевает переключить
       язык раньше, чем отказ вернётся, и тост приходит уже по-английски —
       верное поведение, но проверять им русскую строку нельзя. */
    app.setAutoLockMinutes(5);
    /* Тост приходит из отклонённого промиса записи — ждём, пока очередь
       задач его донесёт. */
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toasts).toContain(ru.errors.settingNotSaved);
  });
});
