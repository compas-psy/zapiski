/**
 * Импорт из выгрузок — не декорация.
 *
 * Заказчик: «Импорт в настройках из Bear, Notion, Evernote, .md, Obsidian
 * Vault не должны быть просто декорацией, а должны быть очень хорошо
 * продуманным, реализованным и отлаженным механизмом, который не вносит хаос».
 *
 * Декорацией он и был, по одной причине: Notion, Bear и Evernote отдают
 * выгрузку АРХИВОМ. Человек выбирал `Export.zip`, до импортёра доезжал один
 * бинарный файл, заметок в нём не находилось, и экран рапортовал
 * «импортировано: 0». Разбор markdown, вложения и защита от перезаписи в ядре
 * при этом были и работали — вхолостую, потому что до них не доходило
 * содержимое.
 *
 * Здесь проверяется путь целиком: архив → распаковка → разбор → запись в
 * хранилище, включая обещание «импорт никогда не перезаписывает существующие
 * заметки» (BEHAVIOR §9).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, ToastProvider } from '@zapiski/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../src/state/context.js';
import { AppController } from '../src/state/store.js';
import { ImportScreen } from '../src/screens/ImportScreen.js';
import { strings } from '../src/i18n/index.js';
import { createTestHost } from './host.js';

const ru = strings('ru');

afterEach(cleanup);

/**
 * Собрать ZIP без сжатия — своими руками.
 *
 * Упаковщик в тесте не нужен: способ хранения 0 («как есть») читают все
 * распаковщики, а зависимость ради двух заголовков тянуть незачем. Заодно
 * проверка не зависит от того, каким упаковщиком пользовался Notion.
 */
function zipOf(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    /* Флаг 11 — имена в UTF-8: в путях кириллица. */
    localView.setUint16(6, 0x0800, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, 0x0800, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...central, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Выгрузка Notion: архив с двумя заметками и вложенной папкой. */
function notionExport(): Uint8Array {
  return zipOf({
    'Export/Планы.md': '# Планы\n\nна неделю\n',
    'Export/Проекты/Записки.md': '# Записки\n\nработа идёт\n',
  });
}

/** Файл, каким его отдаёт браузер после выбора. */
function fileOf(name: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], name, { type: 'application/zip' });
}

async function mount(files: Record<string, string> = {}): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <ImportScreen />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  return app;
}

/** Пройти мастер: выбрать источник, отдать файлы, запустить. */
async function runImport(source: string, files: File[]): Promise<void> {
  fireEvent.click(screen.getByText(source));
  fireEvent.click(screen.getByRole('button', { name: ru.app.continue }));

  const input = document.querySelector('input[type="file"]:not([webkitdirectory])');
  await act(async () => {
    fireEvent.change(input as HTMLInputElement, { target: { files } });
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: ru.importer.start })).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: ru.importer.start }));
  });
}

describe('выгрузка архивом доезжает до заметок', () => {
  it('архив Notion разворачивается и заметки появляются', async () => {
    const app = await mount();
    await runImport(ru.importer.sources.notion, [fileOf('Export.zip', notionExport())]);

    await waitFor(() => {
      const paths = app.getState().notes.map((note) => note.path);
      expect(paths.some((path) => path.includes('Планы')), 'архив не развернулся').toBe(true);
    });
    /* Вложенность сохранена: подпапка выгрузки осталась подпапкой. */
    const paths = app.getState().notes.map((note) => note.path);
    expect(paths.some((path) => path.includes('Проекты/'))).toBe(true);
    app.dispose();
  });

  it('импорт не перезаписывает существующую заметку (BEHAVIOR §9)', async () => {
    /* Главное обещание импорта. Одноимённая заметка обязана уцелеть: чужая
       выгрузка не имеет права затирать то, что человек уже написал. */
    const app = await mount({ 'Планы.md': '# Планы\n\nмоё, не трогать\n' });
    await runImport(ru.importer.sources.notion, [fileOf('Export.zip', notionExport())]);

    await waitFor(() => expect(app.getState().notes.length).toBeGreaterThan(1));
    const mine = await app.vaultRef?.read('Планы.md');
    expect(mine?.body, 'импорт затёр мою заметку').toContain('моё, не трогать');
    app.dispose();
  });

  it('битый архив не роняет импорт', async () => {
    /* «Не вносит хаос» — это и про отказ: испорченный файл обязан кончиться
       нулём импортированных, а не поломкой экрана. */
    const app = await mount();
    await runImport(ru.importer.sources.notion, [
      fileOf('Export.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])),
    ]);
    await waitFor(() => expect(screen.queryByRole('button', { name: ru.app.done })).toBeTruthy());
    expect(app.getState().notes).toHaveLength(0);
    app.dispose();
  });
});

describe('папку можно выбрать папкой', () => {
  it('у выбора папки есть свой вход', async () => {
    /* Obsidian приезжает деревом каталогов. Обычный выбор файлов его не
       берёт: человек либо тыкал в отдельные файлы, теряя структуру, либо не
       мог выбрать ничего. */
    await mount();
    fireEvent.click(screen.getByText(ru.importer.sources.obsidian));
    fireEvent.click(screen.getByRole('button', { name: ru.app.continue }));

    expect(
      document.querySelector('input[type="file"][webkitdirectory]'),
      'выбрать папку по-прежнему нечем',
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: ru.importer.pickFolder })).toBeTruthy();
  });
});
