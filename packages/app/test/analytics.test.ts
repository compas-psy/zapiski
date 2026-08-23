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
import { AppController } from '../src/state/store.js';
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

    await waitFor(() => expect(app.analyticsPendingCount()).toBeGreaterThan(0));
    app.dispose();
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

    const app = await boot();
    await app.completeSignIn({ magicToken: 'ottt' });
    await app.save('Заметки/Первая.md', '# Первая\n\nдописали\n');
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

    const app = await boot();
    await app.completeSignIn({ magicToken: 'ottt' });
    expect(app.getState().account?.analyticsOptIn).toBe(true);

    await app.save('Заметки/Первая.md', NOTE_SECRET);
    await waitFor(() => expect(app.analyticsPendingCount()).toBeGreaterThan(0));

    await waitFor(() => expect(captured.length).toBeGreaterThan(0), { timeout: 4000 });
    await waitFor(() => expect(app.analyticsPendingCount()).toBe(0), { timeout: 4000 });

    for (const body of captured) {
      expect(String(body)).not.toContain(NOTE_SECRET);
    }
    /* И положительная проверка — событие реально ушло, просто без текста. */
    const events = JSON.parse(String(captured[0])).events;
    expect(events[0].event).toBe('note_saved');
    expect(Object.keys(events[0].props).sort()).toEqual(['encrypted', 'length_bucket']);
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
