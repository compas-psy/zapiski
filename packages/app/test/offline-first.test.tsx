/**
 * Приложение без облака: работает, а не ждёт.
 *
 * Заказчик: «если раз синхронизировалось и сохранилось локально, чтобы было
 * доступно, даже при отсутствии подключения к облаку. Работаем локально, пока
 * облако не подключится. А дальше, если локально накопились записки/изменения,
 * то после переключения в онлайн в работу вступает механизм синхронизации с
 * разрешением конфликтов».
 *
 * Ядро это умеет — проверено в `packages/core/test/offline-first.test.ts`.
 * Здесь проверяется вторая половина обещания: что приложение этим умением
 * пользуется. Разница не теоретическая. Движок синхронизации живёт РЯДОМ с
 * подключённым местом: нет места — нет движка. Значит всё, что приложение
 * доверяет движку (очередь неотправленного, счёт объёма, статус), при
 * отключённом облаке проходит мимо, и обещание «накопится и уедет» держится
 * не механизмом, а удачей.
 */
import { LocalFolderBackend, MemoryVaultStorage } from '@zapiski/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { SettingsScreen } from '../src/screens/SettingsScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

afterEach(cleanup);

const ru = strings('ru');

const IDEAS = 'Идеи.md';
const PLANS = 'Планы.md';

/** Устройство с двумя заметками и облаком, которое можно снять и вернуть. */
async function boot() {
  const host = createTestHost({
    files: {
      [IDEAS]: '# Идеи\n\nпервая строка\n',
      [PLANS]: '# Планы\n\nсписок\n',
    },
    prefs: { onboarded: true },
  });
  const app = new AppController(host);
  await app.boot();
  const cloudDisk = new MemoryVaultStorage();
  const cloud = new LocalFolderBackend(cloudDisk, { origin: 'облако' });
  return { app, host, cloud, cloudDisk };
}

describe('приложение работает локально, пока облако не подключилось', () => {
  it('заметки на месте и правятся, когда облака нет вовсе', async () => {
    const { app, host } = await boot();

    expect(app.getState().notes.map((note) => note.path).sort()).toEqual([IDEAS, PLANS]);
    await app.save(IDEAS, '# Идеи\n\nпервая строка\nдописано без облака\n');

    expect(
      String((host.storage as MemoryVaultStorage).snapshot()[IDEAS]),
      'без облака правка не дошла до диска',
    ).toContain('дописано без облака');
    /* И ни одной жалобы: отсутствие облака — не отказ (BEHAVIOR §0). */
    expect(app.getState().syncError).toBeNull();
    app.dispose();
  });

  it('накопленное офлайн помнится как неотправленное, а не только «лежит на диске»', async () => {
    /*
      Это и есть просьба «чтобы накопились изменения». Файл на диске сам по
      себе не говорит, отправляли его или нет: приложение обязано ПОМНИТЬ, что
      обмена не было, — иначе после подключения облака сойтись предстоит по
      косвенным признакам, а статус всё это время показывает «Синхронизировано»
      при полном отсутствии синхронизации.
    */
    const { app, cloud, cloudDisk } = await boot();

    /* Сначала обмен был: заметки уехали, память о них есть. */
    app.attachBackend(cloud);
    await app.syncNow();
    expect(Object.keys(cloudDisk.snapshot())).toContain(IDEAS);

    /* И облако пропало — так выглядит истёкший вход и потерянная сеть. */
    app.attachBackend(null);
    await app.save(IDEAS, '# Идеи\n\nпервая строка\nдописано в дороге\n');
    await app.createNote(undefined, 'В дороге');

    expect(
      app.pendingCount(),
      'приложение не помнит ни одного неотправленного изменения — «накопились» держится на удаче',
    ).toBeGreaterThan(0);
    app.dispose();
  });
});

describe('облако вернулось — накопленное уезжает', () => {
  it('правка и новая заметка доезжают, а очередь пустеет', async () => {
    const { app, cloud, cloudDisk } = await boot();
    app.attachBackend(cloud);
    await app.syncNow();

    app.attachBackend(null);
    await app.save(IDEAS, '# Идеи\n\nпервая строка\nдописано в дороге\n');
    const created = await app.createNote(undefined, 'В дороге');
    expect(created).not.toBeNull();

    /* Вход вернулся — то же место, тот же движок. */
    app.attachBackend(cloud);
    await app.syncNow();

    const uploaded = cloudDisk.snapshot();
    expect(String(uploaded[IDEAS]), 'правка из офлайна не уехала').toContain('дописано в дороге');
    expect(
      Object.keys(uploaded).some((path) => path.startsWith('В дороге')),
      'заметка, написанная без облака, осталась только на устройстве',
    ).toBe(true);
    expect(app.pendingCount(), 'очередь не разобрана после удачного обмена').toBe(0);
    app.dispose();
  });

  it('встречная правка сливается, а не затирает написанное офлайн', async () => {
    const { app, cloud, cloudDisk } = await boot();
    app.attachBackend(cloud);
    await app.syncNow();

    app.attachBackend(null);
    await app.save(IDEAS, '# Идеи\n\nпервая строка\nмоя строка из метро\n');

    /* Пока телефон молчал, второе устройство дописало ту же заметку. */
    await cloudDisk.write(
      IDEAS,
      new TextEncoder().encode('# Идеи\n\nпервая строка (правка с ноутбука)\n'),
    );

    app.attachBackend(cloud);
    await app.syncNow();

    /*
      Строку правили с двух сторон по-разному — построчно это неразрешимо.
      Продукт в таком случае не выбирает победителя молча: своя версия
      остаётся в заметке, чужая уходит в историю версий, и человеку говорят,
      что версии объединены (ТЗ §4.2, BEHAVIOR §6). Проверяем, что уцелели
      обе, — где именно, вопрос второй.
    */
    const local = await app.readNote(IDEAS);
    const noteId = app.vaultRef?.metaOf(IDEAS)?.id ?? 'Идеи';
    const history = await app.versionsFor(noteId);
    const everything = [
      String(cloudDisk.snapshot()[IDEAS]),
      local?.body ?? '',
      ...history.map((snapshot) => snapshot.body),
    ].join('\n');

    expect(everything, 'моя офлайновая правка потерялась').toContain('моя строка из метро');
    expect(everything, 'чужая правка потерялась при возвращении связи').toContain(
      'правка с ноутбука',
    );
    app.dispose();
  });
});

describe('возвращение к приложению досылает накопленное', () => {
  it('открыли ЗАПИСКИ — очередь ушла без единого нажатия', async () => {
    /*
      На телефоне это главный (а часто и единственный) момент, когда синк
      вообще может случиться: приложение спит, событие «сеть вернулась» может
      не прийти ни разу, а «Синхронизировать сейчас» человек нажимать не
      обязан — ему обещали, что накопленное уедет само.
    */
    const { app, cloud, cloudDisk } = await boot();
    app.attachBackend(cloud);
    await app.syncNow();

    app.attachBackend(null);
    await app.save(IDEAS, '# Идеи\n\nнаписано, пока связи не было\n');
    await waitFor(() => expect(app.pendingCount()).toBeGreaterThan(0));

    /* Связь вернулась, но никто ничего не нажимал. */
    app.attachBackend(cloud);
    await app.resumeSync();

    expect(
      String(cloudDisk.snapshot()[IDEAS]),
      'вернулись в приложение, а накопленное так и лежит на устройстве',
    ).toContain('написано, пока связи не было');
    app.dispose();
  });

  it('досылать нечего — в сеть не ходим', async () => {
    /* Обратная сторона: возвращение к приложению случается десятки раз в
       день, и каждое из них не должно превращаться в запрос к облаку. */
    const { app, cloud } = await boot();
    app.attachBackend(cloud);
    await app.syncNow();
    const before = app.getState().sync.lastSyncAt;

    await app.resumeSync();
    expect(app.getState().sync.lastSyncAt, 'сходили в облако без всякой надобности').toBe(before);
    app.dispose();
  });
});

describe('экран настроек говорит правду о синхронизации', () => {
  function mount(app: AppController): void {
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={app.host} controller={app}>
            <SettingsScreen section="sync" />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );
  }

  it('без подключённого места не пишет «Синхронизировано»', async () => {
    /*
      Ровно этот экран заказчик и видел утром: вход в облако истёк за ночь,
      обмена не было ни одного — а сверху стояло «Синхронизировано · ещё не
      было · 0 заметок · 0 Б». Из четырёх слов неправдой были три: обмен не
      состоялся, заметок 75, и объём не ноль.
    */
    const { app } = await boot();
    mount(app);

    expect(
      await screen.findByText(ru.settings.sync.statusLocalOnly),
      'экран объявил синхронизированным то, что не синхронизировали',
    ).toBeTruthy();
    expect(screen.queryByText(ru.settings.sync.statusSynced)).toBeNull();
    /* И число заметок — настоящее, а не «0»: индекс знает его без облака. */
    expect(screen.getByText(/2 заметки/)).toBeTruthy();
    app.dispose();
  });

  it('накопленное без облака названо числом', async () => {
    const { app } = await boot();
    await app.save(IDEAS, '# Идеи\n\nправка без облака\n');
    await waitFor(() => expect(app.pendingCount()).toBeGreaterThan(0));
    mount(app);

    /* Место не подключено — про очередь молчим: сначала надо сказать главное.
       А как только место есть, число ждущих отправки видно. */
    const { app: connected, cloud } = await boot();
    connected.attachBackend(cloud);
    await connected.syncNow();
    await connected.save(IDEAS, '# Идеи\n\nещё правка\n');
    await waitFor(() => expect(connected.pendingCount()).toBeGreaterThan(0));
    cleanup();
    mount(connected);

    expect(
      await screen.findByText(ru.settings.sync.statusPending(connected.pendingCount())),
      'приложение молчит о том, что изменения ещё не уехали',
    ).toBeTruthy();
    app.dispose();
    connected.dispose();
  });

  it('после обмена — «Синхронизировано», и это правда', async () => {
    const { app, cloud } = await boot();
    app.attachBackend(cloud);
    await app.syncNow();
    mount(app);

    expect(await screen.findByText(ru.settings.sync.statusSynced)).toBeTruthy();
    expect(app.getState().sync.lastSyncAt).not.toBeNull();
    app.dispose();
  });
});
