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
  it('по умолчанию — общая папка в корне', async () => {
    const app = await boot();
    const result = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^attachments\//);
  });

  it('«рядом с заметкой» — в папку самой заметки', async () => {
    const app = await boot();
    await app.setAttachmentPlacement('beside');
    const result = await app.attachImage(file('снимок.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^Проекты\//);
    expect(result?.path).not.toContain('attachments/');
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
    expect(result?.path).toMatch(/^attachments\//);
  });
});

describe('под каким именем', () => {
  it('по умолчанию — дата и хеш, без следа исходного имени', async () => {
    /* В имени файла нет ничего личного: снимок с телефона может называться
       как угодно, и хранилище не обязано это повторять. */
    const app = await boot();
    const result = await app.attachImage(file('Отпуск в Сочи.png'), 'Проекты/Идея.md');
    expect(result?.path).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}_[0-9a-f]+\.png$/);
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
    expect(result?.path).toMatch(/^attachments\/\d{4}-\d{2}-\d{2}_схема\.png$/);
  });

  it('одинаковые файлы при имени от хеша не плодят копий', async () => {
    const app = await boot();
    const first = await app.attachImage(file('раз.png'), 'Проекты/Идея.md');
    const second = await app.attachImage(file('два.png'), 'Проекты/Идея.md');
    expect(second?.path).toBe(first?.path);
  });
});

describe('фактический путь виден человеку', () => {
  it('общая папка', async () => {
    expect((await boot()).attachmentPathHint()).toBe('attachments');
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
