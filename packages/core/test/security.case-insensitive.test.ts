/**
 * Регрессия SEC-022: сравнение путей без учёта регистра.
 *
 * Windows (NTFS) и macOS (APFS) не различают регистр в именах файлов.
 * Регистрозависимая проверка служебного каталога позволяла враждебному
 * бэкенду синхронизации отдать в `list()` путь `.ZAPISKI/index.json`,
 * который не попадал под фильтр, считался заметкой — и запись по нему
 * затирала настоящий снапшот индекса vault'а.
 *
 * Имена путей приходят с противоположной стороны синка, поэтому доверять
 * их регистру нельзя.
 */
import { describe, expect, it } from 'vitest';
import {
  isEncryptedPath,
  isMetaPath,
  isNotePath,
} from '../src/util/path.js';

describe('SEC-022: пути сравниваются без учёта регистра', () => {
  it('служебный каталог распознаётся в любом регистре', () => {
    for (const path of [
      '.zapiski/index.json',
      '.ZAPISKI/index.json',
      '.Zapiski/index.json',
      '.zApIsKi/crdt/note.bin',
      '.ZAPISKI',
    ]) {
      expect(isMetaPath(path), `${path} обязан считаться служебным`).toBe(true);
    }
  });

  it('обычная заметка служебной не считается', () => {
    for (const path of ['Заметка.md', 'Проекты/Идея.md', 'zapiski.md']) {
      expect(isMetaPath(path), `${path} — обычная заметка`).toBe(false);
    }
  });

  it('заметка распознаётся при любом регистре расширения', () => {
    // Файл, созданный другим редактором на Windows, иначе не попал бы в список.
    for (const path of ['Заметка.MD', 'Note.Md', 'note.md']) {
      expect(isNotePath(path), `${path} обязан считаться заметкой`).toBe(true);
    }
  });

  it('зашифрованная заметка распознаётся при любом регистре', () => {
    for (const path of ['Дневник.MD.ENC', 'Diary.md.Enc', 'diary.md.enc']) {
      expect(isEncryptedPath(path), `${path} обязан считаться зашифрованным`).toBe(
        true,
      );
    }
  });

  it('не-заметки остаются не-заметками', () => {
    for (const path of ['attachments/photo.PNG', 'readme.txt', 'notes.mdx']) {
      expect(isNotePath(path), `${path} не заметка`).toBe(false);
    }
  });
});
