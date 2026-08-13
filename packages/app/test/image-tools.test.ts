/**
 * Обрезка вложенной картинки (замечание 2) — та её часть, что решает, какие
 * файлы вообще можно перерисовать.
 *
 * Разделение с размером намеренное: ширина в заметке живёт в РАЗМЕТКЕ и
 * проверяется в пакете редактора (`image-width.test.ts`), а здесь — работа с
 * САМИМ ФАЙЛОМ.
 */
import { describe, expect, it } from 'vitest';

import { mimeOfPath } from '../src/lib/crop.js';

describe('обрезка знает, что умеет перерисовать', () => {
  it('растровые форматы — да', () => {
    expect(mimeOfPath('Images/a.png')).toBe('image/png');
    expect(mimeOfPath('Images/a.JPG')).toBe('image/jpeg');
    expect(mimeOfPath('Images/a.webp')).toBe('image/webp');
  });

  it('остальное — нет, и это честный ответ, а не молчание', () => {
    /* gif потерял бы анимацию, svg — векторность, heic вообще не рисуется
       холстом. Обрезать их молча значило бы испортить файл. */
    expect(mimeOfPath('Images/a.gif')).toBe('');
    expect(mimeOfPath('Images/a.svg')).toBe('');
    expect(mimeOfPath('Images/a.heic')).toBe('');
  });
});
