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

/**
 * Порядок в `boot()`: сессию восстанавливаем ДО вопроса «где папка».
 *
 * Заказчик, Android: «не могу синхронизироваться с облаком». Причина была не в
 * облаке. Порт `vaultFolders` не знал про владельца, а `boot()` спрашивал у
 * него `current()` ДО `restoreSession()` — то есть за `local`. На Android этот
 * вопрос по дороге ЗАНИМАЛ выбранную папку за спрашивающим, и учётка после
 * восстановления сессии получала пустую подпапку. Синхронизация исправно
 * работала — с пустотой.
 *
 * Сторож держит два утверждения сразу: вопрос задаётся уже под правильным
 * владельцем И задаётся после того, как сессия восстановлена.
 */
describe('boot спрашивает о папке уже под своим владельцем', () => {
  it('владелец в вопросе совпадает с владельцем открытого хранилища', async () => {
    const asked: Array<string | undefined> = [];
    const host = createTestHost({
      files: FILES,
      prefs: {
        onboarded: true,
        /* Сессия лежит в настройках — ровно так выглядит запуск у человека,
           который вошёл вчера. Без неё владельцем на старте был бы `local`, и
           сторож проходил бы при любом порядке вызовов, ничего не проверяя. */
        'auth.session': {
          accessToken: 'токен',
          refreshToken: 'обновление',
          expiresAt: Date.now() + 3_600_000,
          userId: 'u1',
          email: 'ivan@ya.ru',
          deviceId: 'устройство-1',
        },
      },
      platform: {
        vaultFolders: {
          async chooseFolder() {
            return null;
          },
          async useAppFolder() {
            return null;
          },
          async current(owner?: string) {
            asked.push(owner);
            return { kind: 'app', writeMode: 'atomic', label: 'Записки' };
          },
        },
      },
    });
    const app = new AppController(host);
    await app.boot();

    expect(asked.length, 'о папке не спросили вовсе').toBeGreaterThan(0);
    expect(
      asked[0],
      'о папке спросили за `local`, хотя открывается место учётки',
    ).toBe(app.owner());
  });
});

/**
 * Вход, у которого для новой учётки ещё нет места.
 *
 * `switchOwner` в этом случае ставит экран выбора места — и раньше
 * `completeSignIn` затирал его безусловным переходом «туда, ради чего
 * входили». Человек попадал в список без хранилища: список пуст, «плюс»
 * отвечает «Папка недоступна», и понять, что от него ждут выбора папки,
 * неоткуда.
 */
describe('вход без места для новой учётки', () => {
  it('смена владельца честно сообщает, что места нет', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();

    /* Хост, у которого для чужой учётки места нет: ровно так ведёт себя
       браузер без выбранной папки и Android с отозванным доступом. */
    (host as { restoreVault: (owner?: string) => Promise<unknown> }).restoreVault = async (
      owner?: string,
    ) => (owner === 'local' ? host.storage : null);

    app.setAccount({ email: 'second@ya.ru', plan: 'free', marketingOptIn: false });
    expect(await app.switchOwnerForTest()).toBe(false);
    expect(app.getState().route.name, 'вместо выбора места показали список').toBe('onboarding');
  });

  it('место есть — смена владельца это подтверждает', async () => {
    const { app } = await boot();
    app.setAccount({ email: 'second@ya.ru', plan: 'free', marketingOptIn: false });
    expect(await app.switchOwnerForTest()).toBe(true);
    expect(app.getState().route.name).toBe('list');
  });
});

/**
 * Возврат из Яндекс ID приходит ПОСРЕДИ загрузки — и не имеет права её сбить.
 *
 * Заказчик, Android, свежая установка: «ЯндексID возвращает в приложение,
 * дальше возникает ошибка Папка недоступна», в настройках — 0 файлов и
 * «синхронизация ещё не было».
 *
 * Механика. Возврат приходит по схеме `zapiski://`, Android поднимает
 * приложение заново, начинается `boot()`. Внутри него `listenAuthCallbacks`
 * дёргает `completeSignIn` — намеренно без `await`, боту незачем ждать вход.
 * Дальше два прогона делят одно поле `vault`: `switchOwner` обнуляет его и
 * открывает место учётки, а `boot` открывает место того владельца, который был
 * у него на руках, и записывает результат последним. Облако подключено к
 * учётке, а открыта папка `local` — синхронизация работает с чужой пустой
 * папкой.
 *
 * Сторож держит два утверждения: операции с хранилищем не накладываются, и по
 * итогам открыто место того, кто вошёл.
 */
describe('вход посреди загрузки не сбивает хранилище', () => {
  it('операции с хранилищем не накладываются, открыто место вошедшего', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    let inside = 0;
    let overlapped = false;
    const original = host.restoreVault.bind(host);
    (host as { restoreVault: (owner?: string) => Promise<unknown> }).restoreVault = async (
      owner?: string,
    ) => {
      inside += 1;
      if (inside > 1) overlapped = true;
      /* Пауза обязательна: без неё вызовы не пересеклись бы даже в сломанном
         коде, и сторож проходил бы, ничего не проверив. */
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
      return original(owner);
    };

    const app = new AppController(host);
    /* Ровно то, что делает оболочка: загрузка пошла, а возврат из браузера
       пришёл, не дожидаясь её конца. */
    const booting = app.boot();
    app.setAccount({ email: 'ivan@ya.ru', plan: 'free', marketingOptIn: false });
    const switching = app.switchOwnerForTest();
    await Promise.all([booting, switching]);

    expect(overlapped, 'загрузка и вход открывали хранилище одновременно').toBe(false);
    expect(app.getState().route.name).not.toBe('onboarding');
    /* И место открыто того, кто вошёл, а не того, с кем начиналась загрузка. */
    expect(app.openedForTest()).toBe('ivan@ya.ru');
  });
});

/**
 * Смена папки уводит на новое место и синхронизацию, а не только список.
 *
 * Движок синка держит ссылку на `Vault`, полученную при подключении облака.
 * `openVault` эту ссылку не обновлял — держалось всё на побочном действии:
 * в конце `openVault` зовётся `resumeCloud`, и тот ПРИ УДАЧЕ переподключает
 * облако заново, попутно пересобирая движок.
 *
 * Удача бывает не всегда: нет живой сессии, истёк токен Яндекс.Диска —
 * `resumeCloud` выходит раньше. Тогда движок остаётся на прежней папке и
 * честно синхронизирует её: правки в новой не уезжают никуда, а приезжающее
 * из облака ложится в старую. Со стороны — «выбрал папку, и синхронизация
 * перестала работать».
 */
describe('движок синка идёт за хранилищем', () => {
  it('после смены папки в облако уезжают файлы НОВОЙ папки', async () => {
    const { app, host } = await boot();

    const sent: string[] = [];
    app.attachBackend({
      id: 'zapiski',
      title: 'Облако Записок',
      async list() {
        return [];
      },
      async get() {
        return null;
      },
      async put(path: string) {
        sent.push(path);
        return { etag: '1' };
      },
      async remove() {},
    } as never);
    await app.syncNow();
    expect(sent, 'первая синхронизация ничего не отправила').toContain('Первая.md');

    /* Человек выбрал другую папку — в ней своя заметка и нет прежней. */
    const other = await host.platform.pickVaultDirectory('вторая-папка');
    await other!.write('Вторая.md', new TextEncoder().encode('# Вторая\n'));
    await app.openVault(other!);

    sent.length = 0;
    await app.syncNow();

    expect(sent, 'облако получило файлы прежней папки').not.toContain('Первая.md');
    expect(sent, 'файлы новой папки не уехали').toContain('Вторая.md');
  });
});
