import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/services/blobStore.ts';

/**
 * Шифрование тома на сервере.
 *
 * ── Зачем оно понадобилось ───────────────────────────────────────────────────
 *
 * Пока содержимое шифровал клиент, том получал шифротекст и своего шифра не
 * требовал. Решение владельца — убрать сквозное шифрование из MVP и вернуть его
 * позже провайдером ключей — эту защиту снимает: без встречной меры заметки
 * легли бы в том открытым текстом, и любой, кто получил файлы (снимок диска,
 * резервная копия, увезённый том), прочитал бы их без единого ключа.
 *
 * ── Что здесь стережётся ─────────────────────────────────────────────────────
 *
 * Не «шифр вызывается», а «открытого текста в томе нет». Разница существенна:
 * проверка на вызов проходит и тогда, когда шифротекст лёг рядом с исходником
 * или заголовок остался в имени файла. Поэтому тест читает файл с диска в
 * обход хранилища и ищет в нём исходные байты.
 *
 * Отдельно стережётся то, что адрес и etag считаются от ОТКРЫТОГО текста:
 * они видны клиенту и участвуют в If-Match, поэтому не имеют права зависеть от
 * серверного ключа — иначе смена ключа сломала бы оптимистичную блокировку у
 * всех сразу.
 */

const KEY = Buffer.from('a'.repeat(64), 'hex');
const OTHER_KEY = Buffer.from('b'.repeat(64), 'hex');
const USER = 'user-1';

describe('том сервера: содержимое не лежит открытым текстом', () => {
  let root: string;
  let store: BlobStore;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'zapiski-at-rest-'));
    store = new BlobStore(root, KEY);
    await store.ensureRoot();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('байты в томе не содержат открытого текста', async () => {
    const secret = 'клиент Иванов, сессия 12 — тревога, паническая атака';
    const data = new TextEncoder().encode(secret);

    const stored = await store.putContent(USER, data);
    const onDisk = await readFile(path.join(root, stored.storageKey));

    expect(onDisk.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    expect(onDisk.byteLength).toBeGreaterThan(data.byteLength);
  });

  it('обратно читается ровно то, что положили', async () => {
    const data = randomBytes(2048);
    const stored = await store.putContent(USER, data);

    const back = await store.read(stored.storageKey);
    expect(back).not.toBeNull();
    expect(Buffer.from(back!).equals(Buffer.from(data))).toBe(true);
  });

  it('пустое содержимое переживает круг', async () => {
    const stored = await store.putContent(USER, new Uint8Array());
    const back = await store.read(stored.storageKey);
    expect(back).not.toBeNull();
    expect(back!.byteLength).toBe(0);
  });

  it('адрес, размер и etag считаются от открытого текста, а не от шифротекста', async () => {
    const data = new TextEncoder().encode('одно и то же содержимое');

    const mine = new BlobStore(root, KEY).describeContent(USER, data);
    const alien = new BlobStore(root, OTHER_KEY).describeContent(USER, data);

    // Ключ сервера — его внутреннее дело. Клиент сравнивает etag, и смена
    // ключа не имеет права этот etag сдвинуть.
    expect(alien.storageKey).toBe(mine.storageKey);
    expect(alien.etag).toBe(mine.etag);
    expect(mine.size).toBe(data.byteLength);
  });

  it('одно и то же содержимое не пишется в том дважды', async () => {
    const data = new TextEncoder().encode('повтор ' + randomBytes(8).toString('hex'));

    const first = await store.putContent(USER, data);
    const second = await store.putContent(USER, data);

    expect(first.storageKey).toBe(second.storageKey);
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
  });

  it('испорченный в томе файл не выдаётся за содержимое', async () => {
    const data = new TextEncoder().encode('целостность важнее доступности');
    const stored = await store.putContent(USER, data);

    const file = path.join(root, stored.storageKey);
    const bytes = await readFile(file);
    // Подделка тега GCM. Индекс берём через Buffer API: у tsc с
    // noUncheckedIndexedAccess прямое присваивание в bytes[i] — возможно
    // undefined, и это честная придирка, а не шум.
    bytes.writeUInt8(bytes.readUInt8(bytes.byteLength - 1) ^ 0xff, bytes.byteLength - 1);
    await writeFile(file, bytes);

    await expect(store.read(stored.storageKey)).rejects.toThrow();
  });

  it('чужой ключ не открывает том', async () => {
    const data = new TextEncoder().encode('не для чужих глаз');
    const stored = await store.putContent(USER, data);

    const alien = new BlobStore(root, OTHER_KEY);
    await expect(alien.read(stored.storageKey)).rejects.toThrow();
  });

  it('файл, записанный до шифрования тома, ещё читается', async () => {
    // Обратная совместимость: в томе прод-сервера уже лежат файлы, записанные
    // без серверного шифра. Отказаться их читать — потерять данные людей.
    const legacy = new TextEncoder().encode('{"страница":"опубликована до перехода"}');
    const key = store.keyForPublished('старая-страница');
    const target = path.join(root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, legacy);

    const back = await store.read(key);
    expect(back).not.toBeNull();
    expect(Buffer.from(back!).equals(Buffer.from(legacy))).toBe(true);
  });
});
