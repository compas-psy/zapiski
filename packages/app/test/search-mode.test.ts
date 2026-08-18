/**
 * Размен «скорость поиска ↔ память» — выбор человека, а не наш.
 *
 * Решение заказчика по итогам замера памяти: «можно сделать ползунок в
 * настройках: скорость поиска ↔ память и пусть пользователь выбирает. По
 * умолчанию — скорость поиска».
 *
 * Здесь сторожится проводка: выбор доезжает до ЖИВОГО индекса и переживает
 * перезапуск. Что выдача от режима не меняется — сторожит ядро
 * (`packages/core/test/index.test.ts`).
 */
import { describe, expect, it } from 'vitest';

import { AppController } from '../src/state/store.js';
import { createTestHost } from './host.js';

const FILES = { 'Практика/Заметка.md': '# Заметка\n\nсовершенно особенное слово\n' };

describe('поиск: скорость или память', () => {
  it('по умолчанию — скорость', async () => {
    const app = new AppController(createTestHost({ files: FILES, prefs: { onboarded: true } }));
    await app.boot();
    expect(app.searchModeValue()).toBe('speed');
    expect(app.vaultRef?.index.indexMode).toBe('speed');
  });

  it('выбор доходит до индекса сразу, без перестройки', async () => {
    const app = new AppController(createTestHost({ files: FILES, prefs: { onboarded: true } }));
    await app.boot();

    await app.setSearchMode('memory');

    expect(app.vaultRef?.index.indexMode).toBe('memory');
    /* И поиск продолжает находить: экономия меняет цену, а не ответы. */
    const hits = app.vaultRef?.index.search({ text: 'особенное', filters: {} }) ?? [];
    expect(hits.map((hit) => hit.note.path)).toEqual(['Практика/Заметка.md']);
  });

  it('выбор переживает перезапуск', async () => {
    const host = createTestHost({ files: FILES, prefs: { onboarded: true } });
    const first = new AppController(host);
    await first.boot();
    await first.setSearchMode('memory');
    first.dispose();

    const second = new AppController(host);
    await second.boot();
    expect(second.searchModeValue()).toBe('memory');
    expect(second.vaultRef?.index.indexMode, 'настройка не доехала до индекса').toBe('memory');
  });
});
