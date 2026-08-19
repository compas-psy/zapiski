/**
 * Сквозные правила из ARCHITECTURE §3 и BEHAVIOR §0 — проверяются по коду, а
 * не по памяти ревьюера. Каждый тест здесь соответствует инварианту, нарушение
 * которого на приёмке считается блокирующим дефектом.
 */
import { catalog } from '@zapiski/core';
import { describe, expect, it } from 'vitest';
import RU_CATALOG_SOURCE from '../src/i18n/ru.ts?raw';
import { strings } from '../src/i18n/index.js';

/** Все исходники пакета текстом — путь не зависит от рабочего каталога. */
const SOURCES = import.meta.glob('../src/**/*.{ts,tsx,css}', {
  query: '?raw',
  eager: true,
  import: 'default',
});

const FILES = Object.entries(SOURCES).map(([path, text]) => ({ path, text }));

/**
 * Убирает из исходника то, что пользователь никогда не увидит: комментарии
 * (они для разработчика) и аргументы `new Error(...)` — это диагностика
 * программной ошибки, а не сообщение интерфейса. Настоящие сообщения об
 * ошибках живут в реестре BEHAVIOR §11 и проверяются отдельно.
 */
function stripNoise(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/new Error\([^)]*\)/g, 'new Error()');
}

describe('инвариант 5: ни одной строки, зашитой в компонент', () => {
  it('в экранах нет кириллических литералов вне комментариев', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      if (path.includes('i18n')) continue;
      const literals = stripNoise(text).match(/(['"`])[^'"`\n]*[а-яА-ЯёЁ][^'"`\n]*\1/g) ?? [];
      for (const literal of literals) {
        /* Локаль сортировки — не текст интерфейса. */
        if (literal === "'ru'" || literal === '"ru"') continue;
        offenders.push(`${path}: ${literal}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('инвариант 7: слова «Сохранить» в интерфейсе нет нигде', () => {
  it('ни в русском каталоге, ни в экранах', () => {
    const flat = JSON.stringify(strings('ru'));
    expect(flat).not.toMatch(/Сохранить/);
    for (const { path, text } of FILES) {
      expect(stripNoise(text).includes('Сохранить'), `${path} содержит «Сохранить»`).toBe(false);
    }
  });
});

describe('инвариант 6: ни одного SMS-зависимого пути', () => {
  /**
   * Ни одного упоминания — даже в обещании «мы этого не делаем».
   *
   * Раньше исключение было: «Без паролей и СМС» на экране входа считалось
   * допустимым, потому что это обещание. Заказчик увидел зелёную плашку с этим
   * текстом и прочитал её как «сейчас придёт сообщение»: «внизу зелёный тост,
   * где упоминается смс, который мы не отправляем». Обещать надо то, что
   * произойдёт, — поэтому исключения больше нет.
   */
  it('в строках нет ни СМС, ни телефона, ни кода из сообщения', () => {
    const flat = JSON.stringify(strings('ru')) + JSON.stringify(strings('en'));
    const mentions = flat.match(/СМС|SMS|телефон|phone/gi) ?? [];
    expect(mentions, 'экран обещает то, чего продукт не делает').toEqual([]);
  });
});

describe('инвариант 10: тексты ошибок — дословно из реестра BEHAVIOR §11', () => {
  it('приложение не копирует реестр, а берёт его из ядра', () => {
    expect(strings('ru').errors).toBe(catalog('ru').errors);
    expect(strings('en').errors).toBe(catalog('en').errors);
  });

  it('каталог экранов не переопределяет ни одного текста ошибки', () => {
    const app = RU_CATALOG_SOURCE;
    for (const message of Object.values(catalog('ru').errors)) {
      if (typeof message !== 'string') continue;
      expect(app.includes(message), `реестр продублирован: ${message}`).toBe(false);
    }
  });
});

describe('инвариант 8: диалог подтверждения ровно в трёх местах', () => {
  /*
   * Считаются МЕСТА подтверждения, а не имя компонента.
   *
   * Прежде сторож искал `<ConfirmDialog`, и это оказалось слишком узко.
   * Снятие шифрования требует пароль (`removeEncryption(path, password)`), а
   * «да/нет» его дать не может — потому подтверждение там и не работало
   * годами: диалог стоял, а действия за ним не было. Форма подтверждения
   * теперь другая (поле пароля), место — то же самое и единственное.
   *
   * Инвариант от этого не ослаб: список оснований закрыт типом
   * `ConfirmReason`, каждое встречается ровно один раз, а четвёртое место
   * по-прежнему не скомпилируется.
   */
  const usages = FILES.flatMap(({ path, text }) =>
    [...text.matchAll(/reason="(purge-trash|remove-encryption|unlink-account)"/g)].map(
      (match) => ({ path, reason: match[1] }),
    ),
  );

  it('разрешены только очистка корзины, снятие шифрования и отвязка аккаунта', () => {
    const reasons = new Set(usages.map((usage) => usage.reason));
    expect([...reasons].sort()).toEqual(['purge-trash', 'remove-encryption', 'unlink-account']);
  });

  it('каждое основание используется ровно один раз', () => {
    expect(usages).toHaveLength(3);
  });
});
