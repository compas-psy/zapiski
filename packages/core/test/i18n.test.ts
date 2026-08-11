/**
 * Тексты ошибок — ДОСЛОВНО из реестра BEHAVIOR §11 (DoD: «Тексты всех ошибок
 * соответствуют реестру BEHAVIOR.md §11 дословно»).
 *
 * Тест читает сам документ и сверяет строки посимвольно: расхождение реестра
 * и каталога — красный CI, а не находка на приёмке.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalog, DEFAULT_LOCALE, en, isLocale, resolveLocale, ru } from '../src/i18n/i18n.js';

const BEHAVIOR = fileURLToPath(new URL('../../../docs/spec/BEHAVIOR.md', import.meta.url));

/** Разбирает таблицу §11 «Ситуация | Текст» в пары. */
function registry(): Map<string, string> {
  const text = readFileSync(BEHAVIOR, 'utf-8');
  const section = text.slice(text.indexOf('## 11.'), text.indexOf('## 12.'));
  const out = new Map<string, string>();
  for (const line of section.split('\n')) {
    const match = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (!match) continue;
    const situation = match[1] as string;
    const value = (match[2] as string).replace(/^«|»$/g, '').replace(/»\s*\+.*$/, '').trim();
    if (situation === 'Ситуация' || /^-+$/.test(situation)) continue;
    out.set(situation, value.replace(/^«/, '').replace(/»$/, ''));
  }
  return out;
}

describe('реестр текстов BEHAVIOR §11', () => {
  const table = registry();

  it('таблица реестра прочитана', () => {
    expect(table.size).toBeGreaterThanOrEqual(20);
  });

  const cases: Array<[string, string]> = [
    ['Нет сети при синке', ru.errors.offline],
    ['Синк не удался', ru.errors.syncFailed],
    ['Нет места на диске', ru.errors.noSpace],
    ['Нет доступа к папке', ru.errors.folderUnavailable],
    ['WebDAV: неверные данные', ru.errors.webdavAuth],
    ['WebDAV: сервер недоступен', ru.errors.webdavUnreachable],
    ['Токен Яндекс.Диска истёк', ru.errors.yandexTokenExpired],
    ['Magic-ссылка просрочена', ru.errors.magicLinkExpired],
    ['Неверный пароль шифрования', ru.errors.wrongPassword],
    ['Задержка после попыток', ru.errors.tryLater],
    ['Файл повреждён', ru.errors.fileCorrupted],
    ['Конфликт объединён', ru.errors.conflictMerged],
    ['Конфликт шифрованной', ru.errors.conflictEncrypted],
    ['Не удалось вставить изображение', ru.errors.imageInsertFailed],
    ['Подписка истекла', ru.errors.subscriptionExpired],
    ['Заметка в архиве', ru.errors.noteArchived],
    ['Заметка удалена', ru.errors.noteTrashed],
  ];

  /**
   * Мастер-ТЗ 2.0 переименовало бренд ещё раз и окончательно: продукт —
   * ЗАПИСКИ, наше облако — «Облако Записок», слов «КОМПАС» и «Окоём» в
   * интерфейсе нет вовсе (Р1, Р2). Приложение практики называется по роли, а
   * не по имени: связь между продуктами односторонняя и живёт не здесь
   * (`0_Master.md` §7).
   *
   * `BEHAVIOR.md` §11 остался в прежней редакции, и требование «дословно»
   * противоречит требованию переименовать. Приоритет задан в
   * `docs/spec/README.md` §−1: мастер-ТЗ выше BEHAVIOR. Поэтому эталон
   * приводится к нынешнему именованию ПЕРЕД сверкой — так тест продолжает
   * сторожить формулировки дословно, но не тащит в интерфейс отменённые имена.
   */
  const rename = (text: string): string =>
    text
      .replace(/КОМПАС\.ЗАПИСКИ/g, 'ЗАПИСКИ')
      .replace(/КОМПАС\.Дневник/g, 'приложение практики')
      .replace(/облако КОМПАС/gi, 'Облако Записок')
      .replace(/КОМПАС/g, 'Записки');

  for (const [situation, actual] of cases) {
    it(`«${situation}» совпадает дословно`, () => {
      const expected = table.get(situation);
      expect(expected, `в BEHAVIOR §11 нет строки «${situation}»`).toBeTruthy();
      expect(actual).toBe(rename(expected!));
    });
  }

  it('шаблоны с подстановкой совпадают по форме', () => {
    expect(ru.errors.linksUpdated(20)).toBe((table.get('Ссылки обновлены') ?? '').replace('N', '20'));
    expect(ru.errors.importPartial(1240, 3)).toBe(
      (table.get('Импорт частично не удался') ?? '').replace('N', '1240').replace('M', '3'),
    );
    expect(ru.errors.mailNotDelivered('marina@ya.ru')).toBe(table.get('Письмо не дошло'));
  });
});

describe('каталоги i18n', () => {
  it('основной язык — русский (ТЗ §6)', () => {
    expect(DEFAULT_LOCALE).toBe('ru');
    expect(catalog()).toBe(ru);
    expect(catalog('en')).toBe(en);
  });

  it('en покрывает все ключи ru — ни одной зашитой строки', () => {
    const walk = (value: unknown, path: string[] = []): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, child]) => walk(child, [...path, key]))
        : [path.join('.')];
    expect(walk(en).sort()).toEqual(walk(ru).sort());
  });

  it('выбор языка по списку из ОС', () => {
    expect(resolveLocale(['en-GB', 'ru-RU'])).toBe('en');
    expect(resolveLocale(['de-DE'])).toBe('ru');
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });

  it('в текстах нет восклицательных знаков и слова «ошибка» (правила §11)', () => {
    for (const [key, value] of Object.entries(ru.errors)) {
      if (typeof value !== 'string') continue;
      expect(value, key).not.toContain('!');
      expect(value.toLowerCase(), key).not.toContain('ошибка');
    }
  });
});
