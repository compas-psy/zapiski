/**
 * «Злой синк» — DoD-критерий ТЗ §8 и §4.3:
 * «параллельная правка одной заметки на 3 устройствах оффлайн → все сходятся
 * к одному состоянию без потерь».
 *
 * Три независимых `VaultStorage` (Android, Windows, Web) + общее хранилище
 * контрагента (`LocalFolderBackend` — «просто папка», ТЗ §4.1). Каждое
 * устройство правит заметку оффлайн, затем все синкаются.
 */
import { describe, expect, it } from 'vitest';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { Vault } from '../src/vault/vault.js';
import { SyncEngine } from '../src/sync/engine.js';
import { LocalFolderBackend } from '../src/sync/local-folder.js';
import { mergeTexts } from '../src/crdt/doc.js';
import { diff3 } from '../src/sync/diff3.js';

const NOTE = 'Совещание.md';
const START = '# Совещание\n\nПовестка:\n\n- открытие\n- закрытие\n';

interface Device {
  name: string;
  storage: MemoryVaultStorage;
  vault: Vault;
  sync: SyncEngine;
}

async function makeDevice(name: string, remote: MemoryVaultStorage, clock: () => number): Promise<Device> {
  const storage = new MemoryVaultStorage({ now: clock });
  const vault = await Vault.open(storage, { now: clock, renameDelayMs: 0 });
  const sync = new SyncEngine(vault, new LocalFolderBackend(remote), { deviceName: name, now: clock });
  await sync.load();
  return { name, storage, vault, sync };
}

/** Правка заметки на устройстве: запись `.md` + CRDT-лог + очередь синка. */
async function edit(device: Device, body: string): Promise<void> {
  await device.vault.write(NOTE, body, { scheduleRename: false });
  await device.sync.recordLocalEdit(NOTE, body);
}

function bodyOf(device: Device): string {
  return device.storage.snapshot()[NOTE] as string;
}

describe('«злой синк»: три устройства оффлайн (ТЗ §4.3, §8)', () => {
  it('сходятся к одному состоянию без потерь', async () => {
    let time = 1_700_000_000_000;
    const clock = (): number => (time += 1000);
    const remote = new MemoryVaultStorage({ now: clock });

    const android = await makeDevice('Android', remote, clock);
    const windows = await makeDevice('Windows', remote, clock);
    const web = await makeDevice('Web', remote, clock);

    // Исходное состояние: заметка создана на Android и разъехалась по всем.
    await edit(android, START);
    await android.sync.sync();
    await windows.sync.sync();
    await web.sync.sync();
    expect(bodyOf(windows)).toBe(START);
    expect(bodyOf(web)).toBe(START);

    // Все три уходят в оффлайн и правят одну заметку по-разному.
    await edit(android, START.replace('- закрытие\n', '- закрытие\n- вопрос с Android\n'));
    await edit(windows, START.replace('Повестка:', 'Повестка встречи (правка Windows):'));
    await edit(web, `${START}\nИтог из веба: договорились.\n`);

    // Возвращаются в сеть по очереди — и синкаются дважды: первый круг
    // доносит правки до контрагента, второй — забирает чужие.
    for (let round = 0; round < 2; round += 1) {
      for (const device of [android, windows, web]) {
        const outcome = await device.sync.sync();
        expect(outcome.state === 'synced' || outcome.state === 'syncing').toBe(true);
      }
    }

    const texts = [bodyOf(android), bodyOf(windows), bodyOf(web)];
    // 1. Все устройства в одном состоянии.
    expect(new Set(texts).size).toBe(1);
    // 2. Ни одна правка не потеряна.
    const merged = texts[0] as string;
    expect(merged).toContain('вопрос с Android');
    expect(merged).toContain('правка Windows');
    expect(merged).toContain('Итог из веба');
    // 3. Исходный текст цел.
    expect(merged).toContain('- открытие');
    // 4. Контрагент содержит то же самое.
    expect(remote.snapshot()[NOTE]).toBe(merged);
  });

  it('очередь изменений переживает перезапуск приложения (BEHAVIOR §6)', async () => {
    let time = 1_700_000_000_000;
    const clock = (): number => (time += 1000);
    const remote = new MemoryVaultStorage({ now: clock });
    const device = await makeDevice('Windows', remote, clock);

    await edit(device, START);
    expect(device.sync.queue.size).toBeGreaterThan(0);

    // Перезапуск: новый Vault и новый движок поверх того же диска.
    const restartedVault = await Vault.open(device.storage, { now: clock, renameDelayMs: 0 });
    const restarted = new SyncEngine(restartedVault, new LocalFolderBackend(remote), {
      deviceName: 'Windows',
      now: clock,
    });
    await restarted.load();
    expect(restarted.queue.has(NOTE)).toBe(true);

    const outcome = await restarted.sync();
    expect(outcome.pushed).toBeGreaterThan(0);
    expect(remote.snapshot()[NOTE]).toBe(START);
    expect(restarted.queue.has(NOTE)).toBe(false);
  });

  it('оффлайн не ломает работу: текст сохранён локально, статус — из реестра', async () => {
    let time = 1_700_000_000_000;
    const clock = (): number => (time += 1000);
    const remote = new MemoryVaultStorage({ now: clock });
    const device = await makeDevice('Android', remote, clock);
    await edit(device, START);

    // Контрагент недоступен.
    const broken = new LocalFolderBackend(remote);
    broken.list = async () => {
      throw new Error('сеть отвалилась');
    };
    const offline = new SyncEngine(device.vault, broken, { deviceName: 'Android', now: clock });
    await offline.load();
    const outcome = await offline.sync();
    expect(outcome.state).toBe('error');
    expect(bodyOf(device)).toBe(START);
  });

  it('гибридный режим: облачная версия главная, локальная уходит в историю (ТЗ §4.2)', async () => {
    let time = 1_700_000_000_000;
    const clock = (): number => (time += 1000);
    const remote = new MemoryVaultStorage({ now: clock });

    const storage = new MemoryVaultStorage({ now: clock });
    const vault = await Vault.open(storage, { now: clock, renameDelayMs: 0 });
    const cloud = new SyncEngine(vault, new LocalFolderBackend(remote), {
      deviceName: 'Windows',
      now: clock,
      mode: 'hybrid',
    });
    await cloud.load();

    await vault.write(NOTE, START, { scheduleRename: false });
    await cloud.recordLocalEdit(NOTE, START);
    await cloud.sync();

    // Кто-то поправил файл в облаке, мы — локально.
    await remote.write(NOTE, new TextEncoder().encode(`${START}\nправка из облака\n`));
    const local = `${START}\nлокальная правка\n`;
    await vault.write(NOTE, local, { scheduleRename: false });
    await cloud.recordLocalEdit(NOTE, local);

    const outcome = await cloud.sync();
    expect(outcome.merged + outcome.conflicts).toBeGreaterThan(0);

    const noteId = vault.metaOf(NOTE)?.id as string;
    const history = await cloud.versions.list(noteId);
    // Снапшот локальной версии сохранён в истории.
    expect(history.some((snapshot) => snapshot.body.includes('локальная правка'))).toBe(true);
    expect(bodyOf({ storage } as Device)).toContain('правка из облака');
  });

  it('зашифрованные не сливаются: сохраняются обе версии (BEHAVIOR §5.4)', async () => {
    let time = 1_700_000_000_000;
    const clock = (): number => (time += 1000);
    const remote = new MemoryVaultStorage({ now: clock });
    const device = await makeDevice('Windows', remote, clock);

    const encrypted = 'Дневник.md.enc';
    await device.storage.write(encrypted, new Uint8Array([90, 80, 83, 75, 1, 2, 3]));
    await device.sync.markChanged(encrypted);
    await device.sync.sync();

    await remote.write(encrypted, new Uint8Array([90, 80, 83, 75, 1, 9, 9]));
    await device.storage.write(encrypted, new Uint8Array([90, 80, 83, 75, 1, 4, 4]));
    await device.sync.markChanged(encrypted);
    const outcome = await device.sync.sync();

    expect(outcome.conflicts).toBe(1);
    expect(outcome.messages).toContain('Заметка менялась на двух устройствах. Обе версии сохранены');
    expect(device.storage.paths().some((path) => path.includes('конфликт, устройство Windows'))).toBe(true);
  });
});

describe('слияние текстов', () => {
  it('CRDT сводит расходящиеся правки без маркеров конфликта', () => {
    const base = 'первая строка\nвторая строка\n';
    const mine = 'первая строка\nвторая строка\nмоя добавка\n';
    const theirs = 'первая строка изменена\nвторая строка\n';
    const merged = mergeTexts(base, mine, theirs);
    expect(merged).toContain('моя добавка');
    expect(merged).toContain('изменена');
    expect(merged).not.toContain('<<<<');
  });

  it('diff3 берёт правку одной стороны, когда вторая не менялась', () => {
    const base = 'a\nb\nc\n';
    expect(diff3(base, 'a\nb\nc\nd\n', base).text).toBe('a\nb\nc\nd\n');
    expect(diff3(base, base, 'a\nB\nc\n').text).toBe('a\nB\nc\n');
  });

  it('diff3 объединяет непересекающиеся правки', () => {
    const result = diff3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
    expect(result.ok).toBe(true);
    expect(result.text).toBe('A\nb\nC\n');
  });

  it('diff3 честно сообщает о неразрешимом конфликте', () => {
    const result = diff3('a\nb\nc\n', 'a\nМОЁ\nc\n', 'a\nЧУЖОЕ\nc\n');
    expect(result.ok).toBe(false);
    expect(result.conflicts).toBe(1);
  });
});
