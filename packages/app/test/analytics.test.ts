/**
 * Продуктовая аналитика (O-260817-05, charter/12_ANALYTICS.md Ф3).
 *
 * Правило 2 (12_ANALYTICS.md §1): содержание не измеряется никогда. Здесь
 * это проверяется не только на уровне чистой функции (см.
 * packages/core/test/analytics-schema.test.ts), но и на уровне реального
 * тела исходящего HTTP-запроса — ровно то, что просит O-260817-05.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { buildAnalyticsEvent } from '@zapiski/core';
import { AppController, NOTE_SAVED_QUIET_MS } from '../src/state/store.js';
import { createTestHost } from './host.js';

const NOTE_SECRET =
  'Клиент рассказал про развод и тревогу перед встречей с бывшим мужем, телефон +7 900 123-45-67';

const NOTES = { 'Заметки/Первая.md': '# Первая\n\nТекст\n' };

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function boot(): Promise<AppController> {
  const host = createTestHost({ files: NOTES, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('без согласия — track() тихий no-op', () => {
  it('сохранение, поиск и экспорт не ставят в очередь ничего и не ходят в сеть', async () => {
    const fetchSpy = vi.fn(async () => jsonOk({}));
    vi.stubGlobal('fetch', fetchSpy);
    const app = await boot();

    await app.save('Заметки/Первая.md', '# Первая\n\nдописали\n');
    app.setQuery('текст');
    await new Promise((resolve) => setTimeout(resolve, 150)); // тот же debounce 120мс, что и у поиска
    await app.exportNoteAs('Заметки/Первая.md', 'md');

    expect(app.analyticsPendingCount()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    app.dispose();
  });
});

describe('с согласием — события копятся в очереди', () => {
  it('сохранение ставит note_saved в очередь', async () => {
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    await app.save('Заметки/Первая.md', '# Первая\n\nдописали\n');

    /*
     * Событие созревает после затишья, а не мгновенно: `note_saved` схлопывает
     * серию автосохранений в одно (см. `AppController.noteSaved`). Здесь
     * созревание форсируется `dispose()` — он досылает несозревшее; ждать
     * минуту в тесте незачем, а ослаблять проверку до «когда-нибудь потом»
     * нельзя. Сама проверка та же: событие в очереди есть.
     */
    app.dispose();
    await waitFor(() => expect(app.analyticsPendingCount()).toBeGreaterThan(0));
  });

  it('поиск ставит note_searched в очередь', async () => {
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    app.setQuery('текст');
    await waitFor(() => expect(app.analyticsPendingCount()).toBeGreaterThan(0), { timeout: 2000 });
    app.dispose();
  });

  it('экспорт ставит export_requested в очередь', async () => {
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    await app.exportAll();

    await waitFor(() => expect(app.analyticsPendingCount()).toBeGreaterThan(0));
    app.dispose();
  });

  it('отзыв согласия (app.setAnalyticsConsent) стирает накопленное — задним числом ничего не уходит', async () => {
    const SESSION_BODY = {
      accessToken: 'access-1',
      expiresIn: 900,
      refreshToken: 'refresh-1',
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      user: { id: 'u1', email: 'marina@ya.ru', analyticsOptIn: true },
      device: { id: 'device-1' },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('analytics-consent')) return jsonOk({ analyticsOptIn: false });
      if (url.includes('/analytics/events')) return jsonOk({ accepted: 1 });
      if (url.includes('/auth/')) return jsonOk(SESSION_BODY);
      return jsonOk({ entries: [], quota: { usedBytes: 0, limitBytes: 1 } });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await boot();
    await app.completeSignIn({ magicToken: 'ottt' });
    await app.save('Заметки/Первая.md', '# Первая\n\nдописали\n');
    // Схлопывание note_saved: событие созревает после затишья. Ждём его
    // фальшивыми часами, а не ослабляем проверку.
    await vi.advanceTimersByTimeAsync(NOTE_SAVED_QUIET_MS + 100);
    await waitFor(() => expect(app.analyticsPendingCount()).toBeGreaterThan(0));

    const applied = await app.setAnalyticsConsent(false);

    expect(applied).toBe(false);
    expect(app.getState().account?.analyticsOptIn).toBe(false);
    expect(app.analyticsPendingCount()).toBe(0);
    app.dispose();
  });
});

describe('отправка: тело запроса никогда не несёт содержимого заметки', () => {
  const SESSION_BODY = {
    accessToken: 'access-1',
    expiresIn: 900,
    refreshToken: 'refresh-1',
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    user: { id: 'u1', email: 'marina@ya.ru', analyticsOptIn: true },
    device: { id: 'device-1' },
  };

  it('после сохранения заметки с чувствительным текстом это тело не появляется в отправленных событиях', async () => {
    const captured: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/analytics/events')) {
        captured.push(init?.body);
        return jsonOk({ accepted: 1 });
      }
      if (url.includes('/auth/')) return jsonOk(SESSION_BODY);
      return jsonOk({ entries: [], quota: { usedBytes: 0, limitBytes: 1 } });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await boot();
    await app.completeSignIn({ magicToken: 'ottt' });
    expect(app.getState().account?.analyticsOptIn).toBe(true);

    await app.save('Заметки/Первая.md', NOTE_SECRET);

    /*
     * Ждём фальшивыми часами, а не четырьмя секундами реального времени:
     * `note_saved` теперь созревает после затишья (схлопывание серии
     * автосохранений в одно событие), и до него на провод успевает уйти
     * `sync_completed` — синхронизация дебаунсится пятью секундами.
     * Раньше здесь стояло `captured[0]`, и после правки эта строка стала бы
     * читать чужое событие. Ищем по имени, а не по позиции.
     */
    await vi.advanceTimersByTimeAsync(NOTE_SAVED_QUIET_MS + 5_000);
    await waitFor(() => expect(app.analyticsPendingCount()).toBe(0));

    /* Главное: ни в одном теле нет ни байта содержимого заметки. */
    for (const body of captured) {
      expect(String(body)).not.toContain(NOTE_SECRET);
    }

    /* И положительная проверка — событие реально ушло, просто без текста. */
    const sent = captured.flatMap(
      (body) => (JSON.parse(String(body)) as { events: { event: string; props: object }[] }).events,
    );
    const saved = sent.find((event) => event.event === 'note_saved');
    expect(saved).toBeDefined();
    expect(Object.keys(saved?.props ?? {}).sort()).toEqual(['encrypted', 'length_bucket']);
    app.dispose();
  });
});

describe('доставка большой офлайн-очереди (Д-5): окно, а не вся очередь одним запросом', () => {
  const SESSION_BODY = {
    accessToken: 'access-1',
    expiresIn: 900,
    refreshToken: 'refresh-1',
    refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    user: { id: 'u1', email: 'marina@ya.ru', analyticsOptIn: true },
    device: { id: 'device-1' },
  };

  /**
   * Вход переключает владельца хранилища (`switchOwner`) — очередь, на
   * которую смотрит `doFlushAnalytics`, это очередь, открытая ПОСЛЕ входа,
   * а не та, что могла быть заведена до него. Поэтому копим события через
   * саму очередь работающего контроллера (тот же приём точечного доступа к
   * внутреннему полю, что и в vault-owner.test.ts для `restoreVault`), а не
   * предзаписью файла на диск — предзапись на диск владельца «до входа»
   * осталась бы в чужом, уже не используемом хранилище.
   */
  async function seedQueue(app: AppController, count: number): Promise<void> {
    const queue = (app as unknown as { analytics: { enqueue(event: unknown): Promise<void> } }).analytics;
    for (let i = 0; i < count; i += 1) {
      await queue.enqueue(buildAnalyticsEvent('sync_completed', { pushed: i, pulled: 0, conflicts: 0 }, () => i)!);
    }
  }

  it('500 событий уходят тремя запросами по 200/200/100 — ни один не отбит по размеру', async () => {
    const batchSizes: number[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/analytics/events')) {
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        batchSizes.push(body.events.length);
        return jsonOk({ accepted: body.events.length });
      }
      if (url.includes('/auth/')) return jsonOk(SESSION_BODY);
      return jsonOk({ entries: [], quota: { usedBytes: 0, limitBytes: 1 } });
    });

    const host = createTestHost({ files: NOTES, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    await app.completeSignIn({ magicToken: 'ottt' });
    expect(app.getState().account?.analyticsOptIn).toBe(true);

    await seedQueue(app, 500);
    expect(app.analyticsPendingCount()).toBe(500);

    // Прежняя версия слала `queue.list()` целиком одним запросом — сервер
    // (лимит 200, `server/src/lib/analytics-schema.ts`) отбивал его 400
    // полностью, очередь не пустела вовсе. Здесь — прямой вызов приватного
    // флаша (без ожидания debounce-таймера в 3с), тот же приём, что и в
    // vault-owner.test.ts для доступа к внутреннему методу контроллера.
    await (app as unknown as { doFlushAnalytics(): Promise<void> }).doFlushAnalytics();

    expect(batchSizes).toEqual([200, 200, 100]);
    expect(app.analyticsPendingCount()).toBe(0);
    app.dispose();
  });

  it('окно короче лимита (50 из 450) не блокирует остаток — доходят все запросы', async () => {
    // То же, но проверяет, что цикл идёт до опустошения очереди, а не
    // останавливается после первого успешного окна.
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/analytics/events')) {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { events: unknown[] };
        return jsonOk({ accepted: body.events.length });
      }
      if (url.includes('/auth/')) return jsonOk(SESSION_BODY);
      return jsonOk({ entries: [], quota: { usedBytes: 0, limitBytes: 1 } });
    });

    const host = createTestHost({ files: NOTES, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    await app.completeSignIn({ magicToken: 'ottt' });

    await seedQueue(app, 450);
    await (app as unknown as { doFlushAnalytics(): Promise<void> }).doFlushAnalytics();

    expect(calls).toBe(3); // 200 + 200 + 50
    expect(app.analyticsPendingCount()).toBe(0);
    app.dispose();
  });
});

/**
 * `note_saved` означает «человек сохранил заметку», а не «редактор дёрнулся».
 *
 * ── Как нашлось ──────────────────────────────────────────────────────────────
 *
 * На бою за сутки при ОДНОМ человеке с включённым согласием набралось 268
 * note_saved. Цифра выглядела доказательством живого пути, но проверка
 * происхождения показала другое: кнопки «Сохранить» в продукте нет вовсе
 * (инвариант 7), сохранение — автоматическое, debounce 500 мс плюс blur
 * (`packages/editor/src/save/autosave.ts`, `NoteScreen.tsx:366,466,495`).
 * `track('note_saved')` стоял прямо в `save()`, то есть срабатывал на КАЖДЫЙ
 * сброс автосохранения.
 *
 * Значит «268 сохранений» — это 268 пауз в наборе текста. На панели такая
 * величина не отвечает на вопрос реестра «Люди действительно сохраняют
 * заметки — и как часто пишут длинные?»: она измеряет ритм печати, а не
 * работу с заметкой. Плюс 152-ФЗ: собирать на два порядка больше строк, чем
 * нужно для ответа, — это сбор сверх необходимого.
 *
 * ── Что теперь ───────────────────────────────────────────────────────────────
 *
 * Событие схлопывается по пути заметки: серия автосохранений подряд даёт одно
 * событие, и уходит оно ПОСЛЕ затишья — с итоговой длиной, а не промежуточной.
 * Иначе `length_bucket` описывал бы первый сброс, а вопрос реестра про длину
 * заметки, а не про её длину в середине набора.
 */
describe('note_saved: сессия работы с заметкой, а не сброс автосохранения', () => {
  it('серия автосохранений одной заметки даёт одно событие, а не по одному на сброс', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    // Десять сбросов подряд — ровно так ведёт себя автосохранение, когда
    // человек печатает с паузами по полсекунды.
    for (let i = 0; i < 10; i += 1) {
      await app.save('Заметки/Первая.md', `# Первая\n\n${'слово '.repeat(i + 1)}\n`);
      await vi.advanceTimersByTimeAsync(600);
    }

    // До затишья не ушло ничего: событие ещё складывается.
    expect(app.analyticsPendingCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(NOTE_SAVED_QUIET_MS + 100);
    expect(app.analyticsPendingCount()).toBe(1);

    app.dispose();
  });

  it('две разные заметки — два события: схлопывание по пути, а не общее', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    await app.save('Заметки/Первая.md', '# Первая\n\nраз\n');
    await app.save('Заметки/Вторая.md', '# Вторая\n\nдва\n');
    await vi.advanceTimersByTimeAsync(NOTE_SAVED_QUIET_MS + 100);

    expect(app.analyticsPendingCount()).toBe(2);
    app.dispose();
  });

  it('возврат к заметке после затишья — новое событие, а не вечное молчание', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    await app.save('Заметки/Первая.md', '# Первая\n\nутром\n');
    await vi.advanceTimersByTimeAsync(NOTE_SAVED_QUIET_MS + 100);
    expect(app.analyticsPendingCount()).toBe(1);

    await app.save('Заметки/Первая.md', '# Первая\n\nвечером\n');
    await vi.advanceTimersByTimeAsync(NOTE_SAVED_QUIET_MS + 100);
    expect(app.analyticsPendingCount()).toBe(2);

    app.dispose();
  });

  it('dispose() досылает несозревшее: закрытие приложения не съедает событие', async () => {
    vi.useFakeTimers();
    const app = await boot();
    app.setAccount({ email: 'a@ya.ru', plan: 'free', analyticsOptIn: true });

    await app.save('Заметки/Первая.md', '# Первая\n\nнедописанное\n');
    expect(app.analyticsPendingCount()).toBe(0);

    app.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.analyticsPendingCount()).toBe(1);
  });
});
