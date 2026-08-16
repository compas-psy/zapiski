/**
 * Обратная связь беты: очередь, офлайн и главная граница — утечка.
 *
 * ── Что сторожится ──────────────────────────────────────────────────────────
 *
 * 1. Из формы не уходит содержимого заметок. Сторож в ядре проверяет сборщик
 *    тела; здесь проверяется уровень выше — тот, где диагностика СОБИРАЕТСЯ ИЗ
 *    НАСТОЯЩЕГО ХРАНИЛИЩА. Именно тут легче всего ошибиться: написать
 *    `notes: vault.notes.length` вместо корзины, положить путь в код ошибки,
 *    добавить «последнюю открытую заметку» из лучших побуждений.
 * 2. Форма работает без аккаунта и офлайн: отправка ставится в очередь.
 * 3. Очередь переживает перезапуск приложения.
 * 4. Скриншот по умолчанию не прикладывается.
 */
import { describe, expect, it } from 'vitest';

import type { FeedbackDraft } from '@zapiski/core';

import { AppController } from '../src/state/store.js';
import { createTestHost, memoryPreferences } from './host.js';

/** Хранилище, какое бывает у психолога: клиенты, случаи, личный дневник. */
const NOTES: Record<string, string> = {
  'Клиенты/Смирнова А.md': '# Смирнова Анна\n\nтревожное расстройство, третья сессия\n',
  'Клиенты/Петров И.md': '# Петров Игорь\n\nразвод, страх одиночества\n',
  'Личное/Дневник.md': '# Дневник\n\nтяжело после супервизии\n',
};

const DRAFT: FeedbackDraft = {
  kind: 'broken',
  text: 'Кнопка отправки не срабатывает, экран остаётся прежним',
  entry: 'menu',
};

/** Отличительные строки хранилища — те, что в посторонней речи не встречаются. */
function forbiddenStrings(): string[] {
  const out = new Set<string>();
  for (const [path, body] of Object.entries(NOTES)) {
    out.add(path);
    for (const segment of path.split('/')) {
      out.add(segment);
      out.add(segment.replace(/\.md$/, ''));
    }
    out.add(body);
    const words = body.split(/[\s#\n,.]+/).filter((word) => word.length >= 4);
    for (const word of words) if (/^[А-ЯЁA-Z]/.test(word)) out.add(word);
    for (let i = 0; i + 1 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...out].filter((value) => value.length >= 5);
}

/** Приложение с заметками и перехваченной отправкой обращений. */
async function boot(options: { online?: boolean; prefs?: Record<string, unknown> } = {}) {
  const sent: string[] = [];
  let accept = options.online ?? true;
  const host = createTestHost({
    files: NOTES,
    prefs: { onboarded: true, ...options.prefs },
  });
  const app = new AppController(host, undefined, undefined, {
    feedbackFetch: async (_url, init) => {
      if (!accept) throw new Error('сети нет');
      sent.push(String(init?.body ?? ''));
      return { ok: true, status: 202 } as Response;
    },
  });
  await app.boot();
  return {
    app,
    host,
    sent,
    offline: () => {
      accept = false;
    },
    online: () => {
      accept = true;
    },
  };
}

describe('в обращении нет содержимого заметок', () => {
  it('диагностика собрана из настоящего хранилища и всё равно чиста', async () => {
    const { app, sent } = await boot();
    expect(app.getState().notes.length, 'хранилище пустое — сторожу нечего ловить').toBe(3);

    const outcome = await app.submitFeedback(DRAFT);
    expect(outcome).toBe('sent');
    expect(sent).toHaveLength(1);

    for (const forbidden of forbiddenStrings()) {
      expect(sent[0], `в обращении нашлось содержимое заметок: ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it('размер хранилища уходит корзиной, а не числом', async () => {
    const { app } = await boot();
    const diagnostics = await app.feedbackDiagnostics();

    expect(diagnostics.notes).toBe('<100');
    expect(JSON.stringify(diagnostics)).not.toContain('"3"');
  });

  it('коды ошибок — коды, а не тексты', async () => {
    const { app, sent } = await boot();
    /* Отказ, который человек увидит перед тем, как пожаловаться. */
    app.rememberErrorCode('SYNC_CONFLICT');
    app.rememberErrorCode('Не удалось синхронизировать · Повторить');

    await app.submitFeedback(DRAFT);
    const body = JSON.parse(sent[0] ?? '{}') as { diagnostics?: { errorCodes?: string[] } };

    expect(body.diagnostics?.errorCodes).toEqual(['SYNC_CONFLICT']);
  });
});

describe('форма работает без аккаунта и офлайн', () => {
  it('без сети обращение встаёт в очередь, а не теряется', async () => {
    const { app, sent, offline } = await boot();
    offline();

    expect(app.getState().account, 'проверяем путь без аккаунта').toBeNull();
    const outcome = await app.submitFeedback(DRAFT);

    expect(outcome).toBe('queued');
    expect(sent).toHaveLength(0);
    expect(await app.pendingFeedback()).toBe(1);
  });

  it('сеть появилась — очередь уходит', async () => {
    const { app, sent, offline, online } = await boot();
    offline();
    await app.submitFeedback(DRAFT);
    online();

    await app.flushFeedback();

    expect(sent).toHaveLength(1);
    expect(await app.pendingFeedback()).toBe(0);
  });

  it('повторная отправка того же обращения не заводит второе', async () => {
    const { app, sent, offline, online } = await boot();
    offline();
    await app.submitFeedback(DRAFT);
    online();

    await app.flushFeedback();
    await app.flushFeedback();

    expect(sent, 'обращение ушло дважды: идемпотентность не держится').toHaveLength(1);
  });
});

describe('очередь переживает перезапуск приложения', () => {
  it('накопленное без сети находится после нового запуска', async () => {
    /* Общие настройки на два запуска — это и есть «перезапуск»: процесс новый,
       диск прежний. */
    const prefs = memoryPreferences({ onboarded: true });
    const sent: string[] = [];
    let accept = false;
    const transport = {
      feedbackFetch: async (_url: string, init?: { body?: string }) => {
        if (!accept) throw new Error('сети нет');
        sent.push(String(init?.body ?? ''));
        return { ok: true, status: 202 } as Response;
      },
    };

    const first = new AppController(
      createTestHost({ files: NOTES, prefsStore: prefs }),
      undefined,
      undefined,
      transport,
    );
    await first.boot();
    await first.submitFeedback(DRAFT);
    expect(await first.pendingFeedback()).toBe(1);
    first.dispose();

    const second = new AppController(
      createTestHost({ files: NOTES, prefsStore: prefs }),
      undefined,
      undefined,
      transport,
    );
    await second.boot();

    expect(await second.pendingFeedback(), 'очередь не пережила перезапуск').toBe(1);
    accept = true;
    await second.flushFeedback();
    expect(sent).toHaveLength(1);
  });
});

describe('скриншот', () => {
  it('по умолчанию не прикладывается', async () => {
    const { app, sent } = await boot();
    await app.submitFeedback(DRAFT);
    const body = JSON.parse(sent[0] ?? '{}') as { screenshot?: string };

    expect(body.screenshot).toBeUndefined();
  });
});
