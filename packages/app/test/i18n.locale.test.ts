/**
 * Язык интерфейса (ITERATION-1 §2).
 *
 * Дефект, ради которого написан файл: Windows-сборка открывалась на английском.
 * Причина была не в отсутствии перевода — каталоги полные и склонения на месте,
 * — а в правиле выбора: язык брался из локали ОС. В России английская Windows
 * дело обычное, и человек, купивший русский заметочник, получал «All notes» и
 * «67 words».
 *
 * Второй дефект того же места: `setLocale` писал ключ в настройки, а читать его
 * было некому. Выбранный английский не переживал перезапуск и молча
 * возвращался к тому, что скажет система.
 *
 * Здесь проверяется правило целиком: русский по умолчанию, английский — только
 * явным выбором, и выбор переживает перезапуск.
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { createTestHost, memoryPreferences } from './host.js';

const FILES = { 'Первая.md': '# Первая\n\nтекст\n' };

describe('язык интерфейса — русский, пока не выбран другой', () => {
  it('без сохранённого выбора приложение по-русски', async () => {
    const app = new AppController(createTestHost({ files: FILES, prefs: { onboarded: true } }));
    await app.boot();
    expect(app.getState().locale).toBe('ru');
    expect(app.strings.library.all).toBe('Все заметки');
  });

  it('сохранённый английский поднимается при загрузке', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true, locale: 'en' } });
    const app = new AppController(host);
    await app.boot();
    expect(app.getState().locale).toBe('en');
    expect(app.strings.library.all).toBe('All notes');
  });

  it('выбор языка переживает перезапуск', async () => {
    /* Один и тот же store настроек до и после «перезапуска» — иначе проверять
       нечего: перезапуск и есть новый контроллер над прежними настройками. */
    const prefs = memoryPreferences({ onboarded: true });
    const host = { ...createTestHost({ files: FILES }), prefs };

    const before = new AppController(host);
    await before.boot();
    expect(before.getState().locale).toBe('ru');
    before.setLocale('en');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = new AppController(host);
    await after.boot();
    expect(after.getState().locale).toBe('en');
  });

  it('мусор в настройках не роняет язык в английский', async () => {
    for (const junk of [42, 'de', { locale: 'en' }, null]) {
      const app = new AppController(createTestHost({ files: FILES, prefs: { onboarded: true, locale: junk } }));
      await app.boot();
      expect(app.getState().locale, String(junk)).toBe('ru');
    }
  });
});

describe('русские числительные и даты (ITERATION-1 §2, §9)', () => {
  const app = new AppController(createTestHost({ prefs: { onboarded: true } }));

  it('счётчик слов склоняется', () => {
    const { words } = app.strings.list;
    expect(words(1)).toBe('1 слово');
    expect(words(2)).toBe('2 слова');
    expect(words(5)).toBe('5 слов');
    expect(words(67)).toBe('67 слов');
    /* 11–14 — исключение, на котором ломается наивное правило. */
    expect(words(11)).toBe('11 слов');
    expect(words(21)).toBe('21 слово');
  });

  it('минуты и часы склоняются', () => {
    const { minutesAgo, hoursAgo } = app.strings.relative;
    expect(minutesAgo(1)).toBe('1 минуту назад');
    expect(minutesAgo(5)).toBe('5 минут назад');
    expect(hoursAgo(2)).toBe('2 часа назад');
  });

  it('дата словами: «5 авг» в этом году, «5 августа 2025» в прошлом', () => {
    expect(app.strings.dayMonth(5, 7)).toBe('5 авг');
    expect(app.strings.dayMonthYear(5, 7, 2025)).toBe('5 августа 2025');
    /* Месяц строчными и без точки — §2 требует прямо. */
    expect(app.strings.dayMonth(5, 7)).not.toContain('.');
    expect(app.strings.dayMonth(5, 7)).toBe(app.strings.dayMonth(5, 7).toLowerCase());
  });
});
