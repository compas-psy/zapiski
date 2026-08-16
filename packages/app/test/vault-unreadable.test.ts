/**
 * Утро без заметок: приложение обязано сказать правду и попробовать ещё раз.
 *
 * Заказчик, третье утро подряд: «снова утро, снова пустота». Заметки в папке,
 * приложение показывает пустой список. Утро — это холодный старт: ночью
 * Android убил процесс, а на холодном старте системный провайдер папки (свой у
 * карты памяти, свой у клиента Яндекс.Диска) может быть ещё не поднят.
 *
 * Ядро теперь отличает «в папке пусто» от «папку не прочитать»
 * (`packages/core/test/vault-unreadable`). Здесь проверяется, что приложение
 * этим пользуется: не выдаёт пустой экран за отчёт о хранилище, называет
 * причину словами реестра (BEHAVIOR §11) и возвращает список само, как только
 * папку удалось прочитать.
 */
import { MemoryVaultStorage, type VaultPath, type VaultStorage } from '@zapiski/core';
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

/** Хранилище, которому можно заткнуть обход папки — как это делает провайдер. */
function flaky(inner: MemoryVaultStorage): VaultStorage & { silent: boolean } {
  const wrapper = {
    silent: false,
    read: (path: VaultPath) => inner.read(path),
    write: (path: VaultPath, data: Uint8Array) => inner.write(path, data),
    remove: (path: VaultPath) => inner.remove(path),
    rename: (from: VaultPath, to: VaultPath) => inner.rename(from, to),
    stat: (path: VaultPath) => inner.stat(path),
    mkdir: (dir: VaultPath) => inner.mkdir(dir),
    async list(dir: VaultPath) {
      if (wrapper.silent) throw new Error('провайдер документов не ответил');
      return inner.list(dir);
    },
  };
  return wrapper;
}

/** Устройство, где вчера всё работало: заметки на месте, индекс сохранён. */
async function deviceWithNotes() {
  const inner = new MemoryVaultStorage({
    files: { 'Идеи.md': '# Идеи\n\nтекст\n', 'Планы.md': '# Планы\n' },
  });
  const storage = flaky(inner);
  const host = Object.assign(createTestHost({ prefs: { onboarded: true } }), {
    restoreVault: async () => storage as VaultStorage,
  });
  const yesterday = new AppController(host);
  await yesterday.boot();
  yesterday.dispose();
  return { storage, host };
}

describe('папка молчит на холодном старте', () => {
  it('приложение не выдаёт пустой список за отчёт о хранилище', async () => {
    const { storage, host } = await deviceWithNotes();
    storage.silent = true;

    const morning = new AppController(host);
    await morning.boot();

    /*
      Два утверждения, и второе важнее первого. Список показан прежний — тот,
      что сохранён с прошлого запуска; а рядом сказано, что папка сейчас
      недоступна. Молчание провайдера не превращается ни в «заметок нет», ни в
      бодрое «всё в порядке».
    */
    expect(
      morning.getState().syncError,
      'приложение промолчало о том, что папку не прочитать',
    ).toBe(ru.errors.folderUnavailable);
    expect(
      morning.getState().notes.map((note) => note.path).sort(),
      'заметки объявлены несуществующими из-за одного неотвеченного запроса',
    ).toEqual(['Идеи.md', 'Планы.md']);
    /* И экран списка показывает состояние ошибки, а не «пусто» (BEHAVIOR §12). */
    expect(morning.screenState('list', morning.getState().notes.length === 0)).toBe('error');
    morning.dispose();
  });

  it('провайдер очнулся — список и статус чинятся сами', async () => {
    const { storage, host } = await deviceWithNotes();
    storage.silent = true;
    const morning = new AppController(host);
    await morning.boot();
    expect(morning.getState().syncError).toBe(ru.errors.folderUnavailable);

    /* Ровно то, что делает Android через секунду после запуска. */
    storage.silent = false;
    expect(await morning.retryVault(), 'повторная попытка не удалась при живой папке').toBe(true);

    expect(morning.getState().syncError, 'ошибка осталась висеть после удачного чтения').toBeNull();
    expect(morning.getState().notes).toHaveLength(2);
    morning.dispose();
  });

  it('возвращение к приложению тоже пробует прочитать папку', async () => {
    /* На телефоне это самый частый способ дождаться провайдера: человек ушёл в
       другое приложение и вернулся. Пересматривать в этот момент нечего —
       сначала надо прочитать. */
    const { storage, host } = await deviceWithNotes();
    storage.silent = true;
    const morning = new AppController(host);
    await morning.boot();

    storage.silent = false;
    expect(await morning.rescanVault()).toBe(true);
    expect(morning.getState().notes).toHaveLength(2);
    expect(morning.getState().syncError).toBeNull();
    morning.dispose();
  });

  it('пустая папка остаётся пустой папкой — без ложной тревоги', async () => {
    const host = createTestHost({ prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();

    expect(app.getState().syncError, 'на пустом хранилище поднята тревога о доступе').toBeNull();
    expect(app.getState().notes).toHaveLength(0);
    app.dispose();
  });
});
