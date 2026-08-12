/**
 * Ужимание крупных изображений (ITERATION-1 §5).
 *
 * Тонкая часть здесь не арифметика масштаба, а список случаев, когда ужимать
 * НЕЛЬЗЯ. GIF после canvas теряет анимацию, SVG — векторность, а формат,
 * который браузер не декодирует, роняет всю вставку, если не поймать. Каждый
 * из этих отказов обязан кончаться оригиналом, а не потерянным вложением.
 *
 * `createImageBitmap` и `OffscreenCanvas` подменяются: настоящего декодера
 * картинок в тестовой среде нет, а проверяются решения вокруг него.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downscaleImage, MAX_SIDE } from '../src/lib/downscale.js';

interface FakeCanvas {
  width: number;
  height: number;
}

/** Что «нарисовали» — размеры холста последнего вызова. */
let drawn: FakeCanvas | null = null;

/**
 * Подменяет декодер и холст. `encodedSize` — размер, который отдаёт
 * пересжатие: им проверяется правило «результат больше оригинала не берём».
 */
function stubCanvas(source: { width: number; height: number }, encodedSize = 10): void {
  drawn = null;
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: source.width, height: source.height, close: () => {} })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        drawn = { width, height };
      }
      getContext(): { drawImage: () => void } {
        return { drawImage: () => {} };
      }
      async convertToBlob(options: { type: string }): Promise<Blob> {
        return new Blob([new Uint8Array(encodedSize) as BlobPart], { type: options.type });
      }
    },
  );
}

/** Файл заданного объёма: сравнение «до и после» идёт по байтам. */
function image(name: string, type: string, size = 4000): File {
  return new File([new Uint8Array(size) as BlobPart], name, { type });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('что ужимается', () => {
  it('снимок 4000 px становится 2048 px по длинной стороне', async () => {
    stubCanvas({ width: 4000, height: 3000 });
    const result = await downscaleImage(image('снимок.jpg', 'image/jpeg'));

    expect(result).not.toBeNull();
    expect(drawn?.width).toBe(MAX_SIDE);
    /* Пропорция сохраняется: 3000 × 2048/4000 = 1536. Растянутая картинка
       была бы хуже большой. */
    expect(drawn?.height).toBe(1536);
  });

  it('вертикальный снимок ужимается по высоте, а не по ширине', async () => {
    stubCanvas({ width: 3000, height: 4000 });
    await downscaleImage(image('снимок.jpg', 'image/jpeg'));
    expect(drawn?.height).toBe(MAX_SIDE);
    expect(drawn?.width).toBe(1536);
  });

  it('картинка меньше порога не трогается вовсе', async () => {
    /* JPEG теряет качество на каждом пересжатии, даже когда размер тот же. */
    stubCanvas({ width: 1200, height: 800 });
    expect(await downscaleImage(image('снимок.jpg', 'image/jpeg'))).toBeNull();
    expect(drawn).toBeNull();
  });
});

describe('что не ужимается никогда', () => {
  it('GIF — иначе от анимации остался бы первый кадр', async () => {
    stubCanvas({ width: 4000, height: 4000 });
    expect(await downscaleImage(image('пляска.gif', 'image/gif'))).toBeNull();
  });

  it('SVG — у вектора нет «длинной стороны в пикселях»', async () => {
    stubCanvas({ width: 4000, height: 4000 });
    expect(await downscaleImage(image('схема.svg', 'image/svg+xml'))).toBeNull();
  });

  it('формат, который браузер не декодирует, отдаёт оригинал, а не ошибку', async () => {
    /* HEIC с айфона — ровно этот случай. */
    stubCanvas({ width: 4000, height: 4000 });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('unsupported');
      }),
    );
    await expect(downscaleImage(image('снимок.jpg', 'image/jpeg'))).resolves.toBeNull();
  });

  it('без OffscreenCanvas ужимать нечем — и это не сбой', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn());
    vi.stubGlobal('OffscreenCanvas', undefined);
    await expect(downscaleImage(image('снимок.jpg', 'image/jpeg'))).resolves.toBeNull();
  });
});

describe('результат берётся только если он лучше', () => {
  it('пересжатие крупнее оригинала отбрасывается', async () => {
    /* У PNG со скриншота это обычное дело: canvas перекодирует его хуже, чем
       сжал исходный кодировщик. */
    stubCanvas({ width: 4000, height: 3000 }, 9000);
    expect(await downscaleImage(image('экран.png', 'image/png', 4000))).toBeNull();
  });

  it('формат сохраняется: PNG остаётся PNG', async () => {
    /* Иначе поменялось бы расширение, а с ним и ссылка в тексте. */
    stubCanvas({ width: 4000, height: 3000 });
    const result = await downscaleImage(image('экран.png', 'image/png'));
    expect(result?.type).toBe('image/png');
  });

  it('тип берётся из расширения, когда File.type пуст (Android)', async () => {
    stubCanvas({ width: 4000, height: 3000 });
    const result = await downscaleImage(image('снимок.jpeg', ''));
    expect(result?.type).toBe('image/jpeg');
  });
});
