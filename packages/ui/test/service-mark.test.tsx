/**
 * Знак сервиса — приёмка DS-ALIGNMENT §11 и `ds/zapiski-handoff.md` §6.
 *
 * Проверяется не «как выглядит», а те четыре ограничения, которые ломаются
 * незаметно: контур дерева, КРУПНОСТЬ, геометрия плитки и размер 28 px.
 * Сам файл знака — из дизайн-системы и правкам не подлежит.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MIN_READABLE_SIZE, ServiceMark } from '../src/components/ServiceMark/ServiceMark';

const here = dirname(fileURLToPath(import.meta.url));
const MARK_PATH = resolve(here, '../src/assets/services/zapiski.svg');
const SOURCE_PATH = resolve(here, '../../../docs/spec/ds/zapiski.svg');

afterEach(cleanup);

describe('файл знака', () => {
  const svg = readFileSync(MARK_PATH, 'utf8');

  it('побайтово совпадает с файлом дизайн-системы', () => {
    /* «Иконка — assets/services/zapiski.svg как есть»: ни обрезки,
       ни перерисовки, ни добавления элементов (DS-ALIGNMENT §9). */
    expect(svg).toBe(readFileSync(SOURCE_PATH, 'utf8'));
  });

  it('плитка 500×500 со скруглением 140', () => {
    expect(svg).toContain('viewBox="0 0 500 500"');
    expect(svg).toContain('rx="140"');
  });

  it('высота дерева — 0,60 стороны плитки', () => {
    /*
     * Единственное правило крупности всей системы (`docs/spec/ds/ICON-SPEC.md`
     * §1): высота дерева = 0,60 высоты ВИДИМОЙ плитки. Знак один на девять
     * сервисов СИМПАСа, и разъехаться в нём может только крупность — рядом на
     * домашнем экране разница читается как иконки разных компаний.
     *
     * Здесь раньше проверялось `scale(0.74)` с объяснением «больше — squircle
     * Android подрежет крону». Проверка держала не ту величину и не по той
     * причине: 0,74 — это МАСШТАБ к исходному пути, дерево при нём занимало
     * 0,46 стороны, то есть было мельче нормы; а маска Android решается не
     * плоской плиткой вовсе, у неё свой холст 108 dp с видимыми 72.
     *
     * Число не вписано руками, а выведено из правила прямо здесь: иначе
     * следующая правка снова сверит одну константу с другой.
     */
    const TREE_BBOX_H = 310; // высота bbox знака в исходном viewBox 500×500
    const expected = ((0.6 * 500) / TREE_BBOX_H).toFixed(6);
    expect(svg, `дерево должно идти со scale(${expected})`).toContain(`scale(${expected})`);
  });

  it('фон — плашка: ни градиентов, ни бликов, ни внутренней обводки', () => {
    /* Плитка ЗАПИСОК тёмная, обводка ставится только светлым плиткам. */
    for (const forbidden of ['linearGradient', 'radialGradient', 'filter', 'feGaussianBlur']) {
      expect(svg).not.toContain(forbidden);
    }
    expect(svg).not.toContain('stroke=');
  });

  it('внутри плитки нет надписей', () => {
    expect(svg).not.toContain('<text');
  });
});

describe('ServiceMark', () => {
  it('минимальный размер — 28 px: ниже крона слипается в пятно', () => {
    expect(MIN_READABLE_SIZE).toBe(28);
    render(<ServiceMark label="ЗАПИСКИ" />);
    const mark = screen.getByAltText('ЗАПИСКИ');
    expect(mark).toHaveAttribute('width', '28');
    expect(mark).toHaveAttribute('height', '28');
  });

  it('без подписи знак декоративен и скрыт от скринридера', () => {
    const { container } = render(<ServiceMark size={44} />);
    const mark = container.querySelector('img');
    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('alt', '');
    expect(mark).toHaveAttribute('width', '44');
  });
});
