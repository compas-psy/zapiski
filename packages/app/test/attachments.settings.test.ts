/**
 * Настройки вложений (ITERATION-1 §5).
 *
 * Из письма пользователя: «картинки не вставляются в редактор и непонятно,
 * где хранятся. это не настраивается никак». Вставка на самом деле работала —
 * а вот куда именно ложится файл, узнать было неоткуда: правило было зашито в
 * ядро и нигде не показано.
 *
 * Проверяется поэтому не «настройка сохранилась», а «файл действительно лёг
 * туда, куда обещано, и под тем именем, которое выбрано».
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { createTestHost, memoryPreferences } from './host.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const file = (name: string): File => new File([PNG as BlobPart], name, { type: 'image/png' });

async function boot(prefs: Record<string, unknown> = {}): Promise<AppController> {
  const app = new AppController(
    createTestHost({
      files: { 'Проекты/Идея.md': '# Идея\n\nтекст\n' },
      prefs: { onboarded: true, ...prefs },
    }),
  );
  await app.boot();
  return app;
}

describe('куда ложится вложение', () => {
  it('по умолчанию — папка по типу вложения, в корне', async () => {
    /* Замечание 6: три папки в корне — `Images`, `Audio`, `Other files`.
       Раньше всё сваливалось в одну `attachments/`. */
    const app = await boot();
    const image = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    expect(image?.path).toMatch(/^Images\//);

    const sound = await app.attachImage(file('запись.m4a'), 'Проекты/Идея.md');
    expect(sound?.path).toMatch(/^Audio\//);

    const other = await app.attachImage(file('смета.pdf'), 'Проекты/Идея.md');
    expect(other?.path).toMatch(/^Other files\//);
  });

  it('«рядом с заметкой» — в папку самой заметки', async () => {
    const app = await boot();
    await app.setAttachmentPlacement('beside');
    const result = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^Проекты\//);
    expect(result?.path).not.toContain('Images/');
  });

  it('«рядом» с заметкой из корня кладёт в корень, а не в подпапку', async () => {
    /* Подпапка на каждую заметку превратила бы хранилище в дерево из одного
       файла в каждом узле. */
    const app = await boot();
    await app.setAttachmentPlacement('beside');
    const result = await app.attachImage(file('снимок.png'), 'Заметка.md');
    expect(result?.path).not.toContain('/');
    expect(result?.path.endsWith('.png')).toBe(true);
  });

  it('«своя папка» — по указанному пути', async () => {
    const app = await boot();
    await app.setAttachmentPlacement('custom');
    await app.setAttachmentFolder('файлы');
    const result = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^файлы\//);
  });

  it('пустой путь у «своей папки» откатывается к общей', async () => {
    const app = await boot();
    await app.setAttachmentPlacement('custom');
    await app.setAttachmentFolder('   ');
    const result = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    /* Откат — к умолчанию, а умолчание теперь папка по типу вложения. */
    expect(result?.path).toMatch(/^Images\//);
  });
});

describe('под каким именем', () => {
  it('по умолчанию — дата и хеш, без следа исходного имени', async () => {
    /* В имени файла нет ничего личного: снимок с телефона может называться
       как угодно, и хранилище не обязано это повторять. */
    const app = await boot();
    const result = await app.attachImage(file('Отпуск в Сочи.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^Images\/\d{4}-\d{2}-\d{2}_[0-9a-f]+\.png$/);
    expect(result?.path).not.toContain('Сочи');
  });

  it('исходное имя — как есть, но безопасно', async () => {
    const app = await boot();
    await app.setAttachmentNaming('original');
    const result = await app.attachImage(file('схема сети.png'), 'Проекты/Идея.md');
    expect(result?.path).toContain('схема');
    expect(result?.path.endsWith('.png')).toBe(true);
  });

  it('дата и исходное имя', async () => {
    const app = await boot();
    await app.setAttachmentNaming('date-original');
    const result = await app.attachImage(file('схема.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^Images\/\d{4}-\d{2}-\d{2}_схема\.png$/);
  });

  it('одинаковые файлы при имени от хеша не плодят копий', async () => {
    const app = await boot();
    const first = await app.attachImage(file('раз.png'), 'Проекты/Идея.md');
    const second = await app.attachImage(file('два.png'), 'Проекты/Идея.md');
    expect(second?.path).toBe(first?.path);
  });
});

describe('фактический путь виден человеку', () => {
  it('общая папка — это три папки по типу файла, а не одна attachments', async () => {
    /* Здесь печаталось `attachments`, и это была неправда: файлы уже давно
       ложатся в `Images`, `Audio` и `Other files` (`attachmentDirFor`). То
       есть настройка отправляла человека искать вложения по пути, которого у
       него нет. Проверка держит соответствие подписи и поведения. */
    const hint = (await boot()).attachmentPathHint();
    expect(hint).toContain('Images');
    expect(hint).toContain('Audio');
    expect(hint).toContain('Other files');
  });

  it('своя папка показывает именно её', async () => {
    const app = await boot();
    await app.setAttachmentPlacement('custom');
    await app.setAttachmentFolder('файлы/картинки');
    expect(app.attachmentPathHint()).toBe('файлы/картинки');
  });

  it('«рядом с заметкой» объясняется словами, а не выдуманным путём', async () => {
    /* Конкретного пути тут нет: он свой у каждой заметки. */
    const app = await boot();
    await app.setAttachmentPlacement('beside');
    expect(app.attachmentPathHint()).toBe('папка заметки');
  });
});

describe('выбор переживает перезапуск', () => {
  it('правило размещения и имени поднимаются при загрузке', async () => {
    const prefs = memoryPreferences({ onboarded: true });
    const host = { ...createTestHost({ files: { 'Заметка.md': '# З\n' } }), prefs };

    const before = new AppController(host);
    await before.boot();
    await before.setAttachmentPlacement('custom');
    await before.setAttachmentFolder('файлы');
    await before.setAttachmentNaming('date-original');

    const after = new AppController(host);
    await after.boot();
    expect(after.attachmentPlacementValue()).toBe('custom');
    expect(after.attachmentFolderValue()).toBe('файлы');
    expect(after.attachmentNamingValue()).toBe('date-original');
  });

  it('мусор в настройках откатывается к умолчанию, а не роняет загрузку', async () => {
    const app = await boot({
      'attachments.placement': 42,
      'attachments.naming': { naming: 'original' },
    });
    expect(app.attachmentPlacementValue()).toBe('shared');
    expect(app.attachmentNamingValue()).toBe('hash');
  });
});

/**
 * Ужимание крупных изображений (§5).
 *
 * Снимок с телефона — 4000 px и несколько мегабайт, а в заметке от него видно
 * ширину колонки. §5 ставит «Ужимать до 2048 px» умолчанием; настройки в
 * интерфейсе до этого не было вовсе — по правилу «неработающий переключатель
 * хуже отсутствующего».
 *
 * Сам пересчёт пикселей проверяется там, где он живёт, — в `downscale.ts`.
 * Здесь важно другое: что настройка есть, переживает перезапуск и что отказ
 * ужать НЕ теряет вложение.
 */
describe('крупные изображения', () => {
  it('по умолчанию ужимаются — так написано в §5', async () => {
    const app = await boot();
    expect(app.attachmentDownscaleValue()).toBe(true);
  });

  it('выбор «оставлять оригинал» переживает перезапуск', async () => {
    const prefs = memoryPreferences({ onboarded: true });
    const host = { ...createTestHost({ files: { 'Заметка.md': '# З\n' } }), prefs };

    const before = new AppController(host);
    await before.boot();
    await before.setAttachmentDownscale(false);

    const after = new AppController(host);
    await after.boot();
    expect(after.attachmentDownscaleValue()).toBe(false);
  });

  it('вложение сохраняется и когда ужать не вышло', async () => {
    /* В тестовой среде нет ни `createImageBitmap`, ни `OffscreenCanvas` — то
       есть ровно случай «браузер не умеет». Файл обязан лечь как есть:
       терять вложение из-за неудавшейся экономии нельзя. */
    const app = await boot();
    const result = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/\.png$/);
    expect(await app.vaultRef?.storage.read(result!.path as never)).toBeTruthy();
  });
});
