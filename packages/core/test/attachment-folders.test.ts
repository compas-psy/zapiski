/**
 * Папки вложений — служебные, и ядро обязано их таковыми называть.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * Три снимка: в заметке картинка, звук и документ, а папки `Images`, `Audio` и
 * `Other files` в приложении пустые. И приписка: «файлы по факту в папках
 * есть, но они не отображаются приложением».
 *
 * Причина одна и целиком здесь: дерево папок считает ЗАМЕТКИ, а в этих папках
 * лежат файлы. Ноль заметок — папка выглядит пустой при полной папке на диске.
 * Значит ядро должно и пометить такую папку, и посчитать в ней то, что там
 * действительно есть, и уметь отдать её содержимое списком.
 */
import { describe, expect, it } from 'vitest';

import { MemoryVaultStorage } from '../src/memory-storage.js';
import { isAttachmentDir } from '../src/util/path.js';
import { Vault } from '../src/vault/vault.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function vaultWith(files: Record<string, string>): Promise<Vault> {
  const storage = new MemoryVaultStorage({ files });
  return Vault.open(storage, { renameDelayMs: 0 });
}

describe('признак служебной папки', () => {
  it('три папки вложений в корне — служебные', () => {
    expect(isAttachmentDir('Images')).toBe(true);
    expect(isAttachmentDir('Audio')).toBe(true);
    expect(isAttachmentDir('Other files')).toBe(true);
    /* Старая единая папка — тоже: в ней вложения прежней раскладки. */
    expect(isAttachmentDir('attachments')).toBe(true);
  });

  it('своя папка с тем же именем глубже в дереве — папка человека', () => {
    /* Психолог вполне может завести «Практика/Images» под свои материалы.
       Считать её служебной значило бы отобрать у него папку: серый вид, чужой
       счётчик и запрет класть туда заметки. */
    expect(isAttachmentDir('Практика/Images')).toBe(false);
    expect(isAttachmentDir('')).toBe(false);
  });
});

describe('дерево папок', () => {
  it('папка вложений помечена служебной и считает файлы, а не заметки', async () => {
    const vault = await vaultWith({ 'Идеи.md': '# Идеи\n' });
    await vault.storage.write('Images/2026-08-14_кот.png', PNG);
    await vault.storage.write('Images/2026-08-14_схема.png', PNG);
    await vault.rebuild();

    const images = (await vault.folders()).find((node) => node.path === 'Images');
    expect(images, 'папки Images нет в дереве вовсе').toBeDefined();
    expect(images?.system, 'папка вложений не помечена служебной').toBe(true);
    expect(
      images?.count,
      'счётчик показывает заметки, поэтому папка с двумя файлами выглядит пустой',
    ).toBe(2);
  });

  it('папка человека остаётся обычной', async () => {
    const vault = await vaultWith({ 'Практика/Разбор.md': '# Разбор\n' });
    const practice = (await vault.folders()).find((node) => node.path === 'Практика');
    expect(practice?.system).toBeUndefined();
    expect(practice?.count).toBe(1);
  });
});

describe('содержимое папки вложений', () => {
  it('файлы отдаются списком — с именем, размером и временем', async () => {
    const vault = await vaultWith({});
    await vault.storage.write('Other files/смета.docx', new Uint8Array(12));
    await vault.storage.write('Other files/договор.pdf', new Uint8Array(34));

    const files = await vault.attachmentsIn('Other files');
    expect(files.map((file) => file.name).sort()).toEqual(['договор.pdf', 'смета.docx']);
    const smeta = files.find((file) => file.name === 'смета.docx');
    expect(smeta?.path).toBe('Other files/смета.docx');
    expect(smeta?.size, 'размер файла не прочитан').toBe(12);
  });

  it('пустая папка отдаёт пустой список, а не отказ', async () => {
    const vault = await vaultWith({});
    await expect(vault.attachmentsIn('Audio')).resolves.toEqual([]);
  });
});
