/**
 * Свободный текст обращения не попадает в аналитику ни в каком виде.
 *
 * Спецификация §5 формулирует запрет так: «ни `text`, ни его хеш, ни длина в
 * символах — только корзина (`s`/`m`/`l`)». Хеш перечислен рядом с текстом не
 * для красоты: по хешу короткой фразы восстанавливается сама фраза перебором, а
 * точная длина в паре с типом обращения и временем сама по себе опознаёт
 * человека в маленькой бете.
 *
 * Поэтому запрет здесь встроен в код, а не в договорённость: событие собирает
 * фабрика, которая физически не принимает текст, а сторож проверяет, что в
 * готовом событии нет ни исходной строки, ни её длины, ни ничего, что от неё
 * производно.
 */
import { describe, expect, it } from 'vitest';

import {
  charsBucket,
  feedbackSubmitted,
  assertNoFreeText,
  type FeedbackEvent,
} from '../src/index.js';

/* Больше 120 символов — чтобы корзина в проверке была не крайней («s» вышла бы
   и у пустой строки, и такая проверка ничего не значила бы). */
const TEXT =
  'Поиск не находит заметку по слову из заголовка при включённом шифровании. ' +
  'Пробовал и с телефона, и с компьютера — результат одинаковый.';

describe('корзина вместо длины', () => {
  it('границы корзин заданы и устойчивы', () => {
    expect(charsBucket(0)).toBe('s');
    expect(charsBucket(119)).toBe('s');
    expect(charsBucket(120)).toBe('m');
    expect(charsBucket(499)).toBe('m');
    expect(charsBucket(500)).toBe('l');
    expect(charsBucket(100_000)).toBe('l');
  });
});

describe('событие отправки не несёт текста', () => {
  const event = feedbackSubmitted({
    type: 'broken',
    text: TEXT,
    hasContact: true,
    diagnosticsKept: 4,
    hasScreenshot: false,
    version: '0.1.0',
    platform: 'android',
  });

  it('в событии есть корзина и нет длины', () => {
    expect(event.props.chars_bucket).toBe('m');
    expect(Object.keys(event.props)).not.toContain('chars');
    expect(Object.keys(event.props)).not.toContain('text_length');
  });

  it('ни текста, ни его хеша, ни его длины ни в одном значении', () => {
    const body = JSON.stringify(event);
    expect(body).not.toContain(TEXT);
    for (const word of TEXT.split(' ')) {
      if (word.length >= 5) expect(body, `в событие затёк текст: ${word}`).not.toContain(word);
    }
    /* Длина строкой и числом — оба варианта: «71» в теле события означало бы,
       что запрет обошли самым простым способом. */
    expect(body).not.toContain(String(TEXT.length));
  });

  it('сторож ловит попытку положить текст руками', () => {
    /*
     * Фабрика — не единственный путь: событие можно собрать литералом. Поэтому
     * запрет проверяется ещё и на готовом объекте, и именно эта функция стоит
     * на выходе в порт аналитики.
     */
    const smuggled = {
      name: 'feedback_submitted',
      props: { ...event.props, comment: TEXT },
    } as unknown as FeedbackEvent;

    expect(() => assertNoFreeText(smuggled)).toThrow();
    expect(() => assertNoFreeText(event)).not.toThrow();
  });

  it('сторож ловит длину и хеш, а не только сам текст', () => {
    const withLength = {
      name: 'feedback_submitted',
      props: { ...event.props, chars: TEXT.length },
    } as unknown as FeedbackEvent;
    const withHash = {
      name: 'feedback_submitted',
      props: { ...event.props, text_sha256: 'a'.repeat(64) },
    } as unknown as FeedbackEvent;

    expect(() => assertNoFreeText(withLength)).toThrow();
    expect(() => assertNoFreeText(withHash)).toThrow();
  });
});
