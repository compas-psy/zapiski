/**
 * Из формы обратной связи не уходит ни байта содержимого заметок.
 *
 * ── Почему этот сторож главный ──────────────────────────────────────────────
 *
 * В заметках ЗАПИСОК лежит то, что человек не показывает никому. Утечка одной
 * строки отсюда — это не «баг с приватностью», это конец продукта и, возможно,
 * чужая беда. Поэтому проверка построена не на перечислении полей («в теле нет
 * поля `notes`»), а на обратном утверждении: **берём настоящее хранилище с
 * заметками и ищем в готовом теле запроса КАЖДУЮ строку из них**. Появится
 * завтра новое поле — сторож поймает его, ничего не зная про его имя.
 *
 * Ищем четыре вида строк, и все четыре — содержимое:
 *   · текст заметки (в том числе фрагменты, а не только целиком);
 *   · заголовок;
 *   · путь к файлу;
 *   · имя папки.
 *
 * ── Что НЕ считается утечкой ────────────────────────────────────────────────
 *
 * Свободный текст, который человек сам написал в форму. Он для того и поле,
 * чтобы уехать в поддержку. Поэтому в тестах он заведомо не пересекается с
 * содержимым заметок — иначе сторож ловил бы сам себя.
 */
import { describe, expect, it } from 'vitest';

import { buildFeedbackReport, type FeedbackDiagnostics, type FeedbackDraft } from '../src/index.js';

/** Хранилище, какое бывает у человека: работа, учёба, личные заметки. */
const NOTES: Record<string, string> = {
  'Работа/Переговоры с Ольгой.md': '# Переговоры с Ольгой\n\nусловия аренды, отложить до пятницы\n',
  'Работа/Смета ремонта.md': '# Смета ремонта\n\nплитка дороже сметы, искать замену\n',
  'Личное/Дневник.md': '# Дневник\n\nсегодня было тяжело после переезда\n',
  'Учёба/Конспект вебинара 14.md': '# Конспект вебинара 14\n\nвторая глава, обсудить с наставником\n',
};

/**
 * Все строки, которых в теле запроса быть не должно.
 *
 * ── Почему не «каждое слово из заметок» ─────────────────────────────────────
 *
 * Первая редакция сторожа брала каждое слово длиннее четырёх букв — и поймала
 * слово «после» в тексте, который человек сам написал в форму («не срабатывает
 * ПОСЛЕ поворота экрана»). Это ложная тревога: обычное слово русского языка
 * принадлежит не заметке, а языку, и запрещать его — значит запрещать людям
 * писать в поддержку.
 *
 * Поэтому ищем ОТЛИЧИТЕЛЬНОЕ, то есть то, что не встречается в посторонней
 * речи: полный текст заметки, каждая её строка, путь, каждый сегмент пути,
 * имена собственные и пары соседних слов. Пара «после переезда» в жалобе на
 * кнопку не появится никогда, а частичную утечку она ловит так же надёжно, как
 * и целый файл.
 */
function forbiddenStrings(): string[] {
  const out = new Set<string>();
  for (const [path, body] of Object.entries(NOTES)) {
    out.add(path);
    for (const segment of path.split('/')) {
      out.add(segment);
      out.add(segment.replace(/\.md$/, ''));
    }
    out.add(body);
    for (const line of body.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (trimmed.length >= 5) out.add(trimmed);
    }
    const words = body.split(/[\s#\n,.]+/).filter((word) => word.length >= 4);
    for (const word of words) {
      /* Имена собственные — сами по себе отличительные: чужая фамилия в теле
         запроса не объясняется «это просто слово». */
      if (/^[А-ЯЁA-Z]/.test(word)) out.add(word);
    }
    for (let i = 0; i + 1 < words.length; i += 1) {
      out.add(`${words[i]} ${words[i + 1]}`);
    }
  }
  return [...out].filter((value) => value.length >= 5);
}

const DIAGNOSTICS: FeedbackDiagnostics = {
  version: '0.1.0',
  platform: 'android',
  locale: 'ru',
  notes: '<100',
  encryption: true,
  errorCodes: ['SYNC_CONFLICT', 'IDX_TIMEOUT'],
  daysSinceInstall: 12,
};

const DRAFT: FeedbackDraft = {
  kind: 'broken',
  /* Свой текст человека — он и должен уехать. С содержимым заметок не
     пересекается намеренно: иначе сторож ловил бы сам себя. */
  text: 'Кнопка отправки не срабатывает после поворота экрана',
  entry: 'menu',
};

function bodyText(value: unknown): string {
  return JSON.stringify(value);
}

describe('в теле обращения нет содержимого заметок', () => {
  it('ни текста, ни заголовка, ни пути, ни имени папки', () => {
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000001',
      createdAt: 1_786_900_000_000,
      draft: DRAFT,
      diagnostics: DIAGNOSTICS,
    });

    const body = bodyText(report);
    for (const forbidden of forbiddenStrings()) {
      expect(body, `в теле обращения нашлось содержимое заметок: ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it('код ошибки, похожий на путь, в тело не попадает', () => {
    /*
     * Коды ошибок — единственное место диагностики, куда теоретически может
     * затечь путь: их собирает приложение из своих отказов, а отказ бывает
     * связан с файлом. Поэтому код обязан быть КОДОМ: заглавные латинские
     * буквы, цифры и подчёркивание. Всё остальное отбрасывается целиком, а не
     * «очищается» — очистка оставила бы обрывок пути.
     */
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000002',
      createdAt: 1_786_900_000_000,
      draft: DRAFT,
      diagnostics: {
        ...DIAGNOSTICS,
        errorCodes: ['SYNC_CONFLICT', 'Работа/Переговоры с Ольгой.md', 'read /vault/Личное/Дневник.md'],
      },
    });

    expect(report.diagnostics?.errorCodes).toEqual(['SYNC_CONFLICT']);
    const body = bodyText(report);
    for (const forbidden of forbiddenStrings()) {
      expect(body, `код ошибки протащил содержимое: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('отключённый пункт диагностики не уезжает вовсе', () => {
    /* «Каждый пункт отключается» — значит именно отключается, а не заменяется
       на `null`: пустое поле рядом с остальными — тоже сообщение. */
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000003',
      createdAt: 1_786_900_000_000,
      draft: DRAFT,
      diagnostics: DIAGNOSTICS,
      consent: { errorCodes: false, notes: false },
    });

    expect(report.diagnostics).toBeDefined();
    expect(Object.keys(report.diagnostics ?? {})).not.toContain('errorCodes');
    expect(Object.keys(report.diagnostics ?? {})).not.toContain('notes');
    /* А неотключённое — на месте: сторож не должен проходить от того, что
       диагностику вырезали целиком. */
    expect(report.diagnostics?.version).toBe('0.1.0');
  });

  it('отключённая диагностика целиком — поля нет', () => {
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000004',
      createdAt: 1_786_900_000_000,
      draft: DRAFT,
      diagnostics: DIAGNOSTICS,
      consent: {
        version: false,
        platform: false,
        locale: false,
        notes: false,
        encryption: false,
        errorCodes: false,
        daysSinceInstall: false,
      },
    });

    expect(report.diagnostics).toBeUndefined();
  });
});

describe('скриншот прикладывается только явно', () => {
  it('по умолчанию его нет', () => {
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000005',
      createdAt: 1_786_900_000_000,
      draft: DRAFT,
      diagnostics: DIAGNOSTICS,
    });

    expect(report.screenshot).toBeUndefined();
  });

  it('приложенный — уезжает как есть, но только по просьбе', () => {
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000006',
      createdAt: 1_786_900_000_000,
      draft: { ...DRAFT, screenshot: 'ZmFrZS1wbmc=' },
      diagnostics: DIAGNOSTICS,
    });

    expect(report.screenshot).toBe('ZmFrZS1wbmc=');
  });
});

describe('контакт необязателен', () => {
  it('пустой контакт не превращается в пустую строку в теле', () => {
    const report = buildFeedbackReport({
      id: 'f1e2d3c4-0000-4000-8000-000000000007',
      createdAt: 1_786_900_000_000,
      draft: { ...DRAFT, contact: '   ' },
      diagnostics: DIAGNOSTICS,
    });

    expect(report.contact).toBeUndefined();
  });
});
