/**
 * Реестр событий аналитики (O-260817-05, `analytics/schema/events.yaml`).
 * Критический тест здесь — не про удобство API, а про безопасность:
 * содержимое заметки, попавшее в `props` под любым ключом, не должно
 * пережить `buildAnalyticsEvent` ни в каком виде.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENT_SCHEMA,
  buildAnalyticsEvent,
  lengthBucket,
} from '../src/analytics/schema.js';

const NOTE_CONTENT =
  'Клиент рассказал про развод и тревогу перед встречей с бывшим мужем, телефон +7 900 123-45-67';

describe('lengthBucket', () => {
  it('корзинирует по границам, не по точному числу', () => {
    expect(lengthBucket(0)).toBe('xs');
    expect(lengthBucket(99)).toBe('xs');
    expect(lengthBucket(100)).toBe('s');
    expect(lengthBucket(499)).toBe('s');
    expect(lengthBucket(500)).toBe('m');
    expect(lengthBucket(1999)).toBe('m');
    expect(lengthBucket(2000)).toBe('l');
    expect(lengthBucket(4999)).toBe('l');
    expect(lengthBucket(5000)).toBe('xl');
  });

  it('не падает на отрицательных и нечисловых значениях', () => {
    expect(lengthBucket(-5)).toBe('xs');
    expect(lengthBucket(Number.NaN)).toBe('xs');
  });
});

describe('buildAnalyticsEvent', () => {
  it('строит событие из известных полей известного события', () => {
    const built = buildAnalyticsEvent(
      'note_saved',
      { length_bucket: 'm', encrypted: true },
      () => 0,
      () => 'fixed-id',
    );
    expect(built).toEqual({
      event: 'note_saved',
      ts: new Date(0).toISOString(),
      props: { length_bucket: 'm', encrypted: true },
      schemaVersion: 1,
      eventId: 'fixed-id',
    });
  });

  it('eventId стабилен на постановке в очередь: не своя генерация при каждом чтении, разные события — разные id по умолчанию (C3, идемпотентность на приёме)', () => {
    // Без инъекции: реальный генератор — не должен ни разу вернуть пустую
    // строку и не должен повторяться на соседних вызовах (иначе уникальный
    // индекс на сервере схлопнул бы РАЗНЫЕ события в одну строку).
    const a = buildAnalyticsEvent('note_saved', { length_bucket: 'xs', encrypted: false }, () => 0);
    const b = buildAnalyticsEvent('note_saved', { length_bucket: 'xs', encrypted: false }, () => 0);
    expect(a?.eventId).toBeTruthy();
    expect(b?.eventId).toBeTruthy();
    expect(a?.eventId).not.toBe(b?.eventId);
  });

  it('неизвестное имя события — null, не «событие без полей»', () => {
    expect(buildAnalyticsEvent('note_deleted_forever', {}, () => 0)).toBeNull();
    expect(buildAnalyticsEvent('', {}, () => 0)).toBeNull();
  });

  it('отбрасывает поля, не объявленные для этого события', () => {
    const built = buildAnalyticsEvent(
      'note_saved',
      { length_bucket: 'xs', encrypted: false, path: 'Клиенты/Иванов.md', title: 'Секрет' },
      () => 0,
    );
    expect(built?.props).toEqual({ length_bucket: 'xs', encrypted: false });
    expect(built?.props).not.toHaveProperty('path');
    expect(built?.props).not.toHaveProperty('title');
  });

  it('отбрасывает объявленное поле с неподходящим типом вместо того, чтобы пропустить его как есть', () => {
    const built = buildAnalyticsEvent(
      'note_saved',
      { length_bucket: 123, encrypted: 'true' },
      () => 0,
    );
    expect(built?.props).toEqual({});
  });

  it('содержимое заметки, подсунутое под чужим ключом, никогда не попадает в событие', () => {
    for (const eventName of Object.keys(ANALYTICS_EVENT_SCHEMA)) {
      const built = buildAnalyticsEvent(
        eventName,
        { note: NOTE_CONTENT, query: NOTE_CONTENT, body: NOTE_CONTENT, title: NOTE_CONTENT },
        () => 0,
      );
      expect(JSON.stringify(built)).not.toContain(NOTE_CONTENT);
    }
  });

  it('содержимое заметки, подсунутое под объявленным строковым (enum) ключом, отбрасывается — не проходит как «просто строка»', () => {
    const built = buildAnalyticsEvent('export_requested', { format: NOTE_CONTENT, notes_count: 1 }, () => 0);
    expect(built?.props).toEqual({ notes_count: 1 });
    expect(JSON.stringify(built)).not.toContain(NOTE_CONTENT);
  });
});

describe('согласие реестра analytics/schema/events.yaml с ANALYTICS_EVENT_SCHEMA', () => {
  it('имена событий и их поля совпадают построчно', () => {
    const yamlPath = fileURLToPath(
      new URL('../../../analytics/schema/events.yaml', import.meta.url),
    );
    const yaml = readFileSync(yamlPath, 'utf-8');

    for (const [eventName, props] of Object.entries(ANALYTICS_EVENT_SCHEMA)) {
      expect(yaml).toContain(`  ${eventName}:`);
      for (const propName of Object.keys(props)) {
        expect(yaml).toContain(`      ${propName}:`);
      }
    }

    // И в обратную сторону: в yaml нет события, которого нет в схеме — иначе
    // реестр обещает то, что код не проверяет.
    const declaredEvents = [...yaml.matchAll(/^ {2}(\w+):\n {4}question:/gm)].map((m) => m[1]);
    expect(declaredEvents.sort()).toEqual(Object.keys(ANALYTICS_EVENT_SCHEMA).sort());
  });
});
