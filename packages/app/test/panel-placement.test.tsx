/**
 * Место панели форматирования (ITERATION-1 §4).
 *
 * Заказчик: «Меню форматирования отображается фиксированно над заголовком,
 * отнимая место у области редактирования. На дизайнах заголовок заметки должен
 * быть уместно вверху под хлебными крошками. Местоположение меню форматирования
 * должно выбираться пользователем в настройках. По-умолчанию, уместно внизу,
 * по-середине по-горизонтали области редактора. Меню может быть плавающим:
 * пользователь перетягивает его мышкой и приложение запоминает его
 * местоположение (не чётко в координатах, а относительно ближайших краёв…)».
 *
 * Здесь проверяется то, что от раскладки не зависит: какой вариант выбран, есть
 * ли ручка и ЧТО ИМЕННО запоминается после перетаскивания. Само положение на
 * экране — координатами, в браузерном прогоне: в happy-dom раскладки нет.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import type { PanelSpot } from '@zapiski/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { FormatPanelSlot } from '../src/components/FormatPanelSlot.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

/**
 * Область редактора и панель с известными размерами.
 *
 * В happy-dom всё нулевое, а вся арифметика краёв считается по
 * прямоугольникам, — значит их надо задать. Область 800×600, панель 200×40.
 */
function measured(node: HTMLElement, rect: Partial<DOMRect>): void {
  node.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, ...rect }) as DOMRect;
}

async function mount(
  placement: 'bottom' | 'top' | 'floating',
  spot: PanelSpot | null,
  onMove: (spot: PanelSpot) => void = () => undefined,
): Promise<HTMLElement> {
  const host = createTestHost({ files: { 'Заметка.md': '# Заметка\n' }, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  const { container } = render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          {/* Обёртка играет роль `.za-editor__host`: от неё считаются края. */}
          <div className="za-editor__host" style={{ position: 'relative' }}>
            <FormatPanelSlot placement={placement} spot={spot} mobile={false} onMove={onMove}>
              <div className="zp-panel">панель</div>
            </FormatPanelSlot>
          </div>
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  const panel = container.querySelector('.za-editor__panel') as HTMLElement;
  const editorHost = container.querySelector('.za-editor__host') as HTMLElement;
  measured(editorHost, { width: 800, height: 600, top: 0, left: 0 });
  measured(panel, { width: 200, height: 40, top: 540, left: 300 });
  /* `offsetParent` в happy-dom пуст: подменяем — иначе слот не найдёт область. */
  Object.defineProperty(panel, 'offsetParent', { value: editorHost, configurable: true });
  return panel;
}

describe('где стоит панель форматирования', () => {
  it('внизу — умолчание, и это отдельный класс, а не «просто панель»', async () => {
    const panel = await mount('bottom', null);
    expect(panel.className).toContain('za-editor__panel--bottom');
    expect(panel.className).not.toContain('za-editor__panel--float');
    expect(panel.querySelector('.za-editor__grip'), 'у неподвижной панели ручка ни к чему').toBeNull();
  });

  it('вверху — второй вариант из настроек', async () => {
    const panel = await mount('top', null);
    expect(panel.className).toContain('za-editor__panel--top');
  });

  it('плавающая: за неё есть чем взяться', async () => {
    const panel = await mount('floating', null);
    expect(panel.className).toContain('za-editor__panel--float');
    expect(screen.getByRole('button', { name: ru.settings.editor.panelMove })).toBeTruthy();
  });
});

describe('плавающая панель запоминает край, а не координату', () => {
  /** Протащить ручку из середины низа в заданную точку области. */
  async function drag(
    panel: HTMLElement,
    to: { x: number; y: number },
  ): Promise<void> {
    const grip = panel.querySelector('.za-editor__grip') as HTMLElement;
    grip.setPointerCapture = () => undefined;
    /* Каждое событие — своим `act`: React объединяет обновления внутри одного,
       и тогда `pointermove` не видит уже начатого перетаскивания. */
    await act(async () => {
      fireEvent.pointerDown(grip, { clientX: 400, clientY: 560, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerMove(grip, { clientX: to.x, clientY: to.y, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(grip, { pointerId: 1 });
    });
  }

  it('утащили влево-вверх — запомнены левый и верхний края', async () => {
    const moved = vi.fn();
    const panel = await mount('floating', null, moved);
    /* Панель 200×40 стоит на 300,540 в области 800×600. Тащим на 150 влево и
       на 350 вверх: её центр (250, 210) оказывается в левой верхней четверти,
       и запомниться обязаны левый и верхний края. */
    await drag(panel, { x: 250, y: 210 });

    expect(moved, 'перетаскивание ничего не запомнило').toHaveBeenCalledTimes(1);
    const spot = moved.mock.calls[0]?.[0] as PanelSpot;
    expect(spot.side, 'ближе к левому краю, а запомнен правый').toBe('start');
    expect(spot.block, 'ближе к верхнему краю, а запомнен нижний').toBe('start');
    /* 300 − 150 = 150 от левого края, 540 − 350 = 190 от верхнего. */
    expect(spot.inline).toBe(150);
    expect(spot.offset).toBe(190);
  });

  it('утащили вправо-вниз — запомнены правый и нижний края', async () => {
    const moved = vi.fn();
    const panel = await mount('floating', null, moved);
    await drag(panel, { x: 700, y: 600 });

    const spot = moved.mock.calls[0]?.[0] as PanelSpot;
    expect(spot.side).toBe('end');
    expect(spot.block).toBe('end');
    /* Ушла бы за правый край — упирается: 800 − 200 = 600, отступ 0. */
    expect(spot.inline).toBe(0);
    expect(spot.offset).toBe(0);
  });

  it('за край области панель не уводится', async () => {
    const moved = vi.fn();
    const panel = await mount('floating', null, moved);
    await drag(panel, { x: -5000, y: -5000 });

    const spot = moved.mock.calls[0]?.[0] as PanelSpot;
    expect(spot.side).toBe('start');
    expect(spot.block).toBe('start');
    expect(spot.inline).toBe(0);
    expect(spot.offset).toBe(0);
  });

  it('запомненный край превращается в положение, а не в координату', async () => {
    const panel = await mount('floating', { side: 'end', block: 'start', inline: 24, offset: 12 });
    expect(panel.style.right, 'отступ от правого края потерян').toBe('24px');
    expect(panel.style.top).toBe('12px');
    expect(panel.style.left, 'у панели у правого края не должно быть левой координаты').toBe('');
  });
});
