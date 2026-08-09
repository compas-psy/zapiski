/**
 * РЕГРЕССИОННЫЙ ТЕСТ-КЕЙС №1 (BEHAVIOR §2.1).
 *
 * «Композиция IME никогда не прерывается декорациями: перерисовка live-preview
 * откладывается до `compositionend`. Автозамена, свайп-ввод и диктовка ОС
 * обязаны работать без символов-призраков.»
 *
 * Проверяем именно механику, а не «выглядит нормально»:
 *   1) во время композиции набор декораций не пересчитывается — только
 *      сдвигается по изменениям документа;
 *   2) после `compositionend` пересчёт происходит сам, без ввода пользователя;
 *   3) текст, набранный композицией (кириллица, свайп, автозамена), приходит
 *      в документ ровно один раз и без лишних символов.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { compositionDeferrals, isComposing } from '../src/ime/composition.js';
import { makeView } from './helpers.js';

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/** Композиционное событие: jsdom не знает CompositionEvent, шлём совместимое. */
function fireComposition(target: EditorView, type: 'compositionstart' | 'compositionend', data = ''): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { data: string };
  event.data = data;
  target.contentDOM.dispatchEvent(event);
}

/** Слепок декораций плагина live-preview в виде «от-до-класс». */
function decoSnapshot(target: EditorView): string[] {
  const out: string[] = [];
  for (const set of target.state.facet(EditorView.decorations)) {
    const value = typeof set === 'function' ? set(target) : set;
    const iter = value.iter();
    while (iter.value) {
      const spec = iter.value.spec as { class?: string };
      if (spec.class) out.push(`${iter.from}-${iter.to}:${spec.class}`);
      iter.next();
    }
  }
  return out;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('IME: перерисовка откладывается до compositionend', () => {
  it('во время композиции пересчёт декораций не происходит', async () => {
    view = makeView('Текст **жирный** дальше.', { selection: { anchor: 0 } });
    const before = decoSnapshot(view);
    const deferralsBefore = compositionDeferrals(view);

    fireComposition(view, 'compositionstart');
    expect(isComposing(view)).toBe(true);

    // Клавиатура «набирает» слово посимвольно, как это делает IME.
    for (const ch of 'при') {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 } });
    }

    expect(compositionDeferrals(view)).toBeGreaterThan(deferralsBefore);
    // Классы прежние — набор только сдвинулся вместе с текстом.
    const during = decoSnapshot(view);
    expect(during.map((s) => s.split(':')[1])).toEqual(before.map((s) => s.split(':')[1]));

    fireComposition(view, 'compositionend', 'при');
    await tick();

    expect(isComposing(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('приТекст **жирный** дальше.');
  });

  it('после compositionend декорации пересобираются сами, без нового ввода', async () => {
    view = makeView('обычный текст', { selection: { anchor: 0 } });

    fireComposition(view, 'compositionstart');
    // Композиция превращает начало строки в заголовок.
    view.dispatch({ changes: { from: 0, insert: '## ' }, selection: { anchor: 3 } });

    // Пока идёт композиция — декорации заголовка ещё не появились.
    expect(decoSnapshot(view).some((s) => s.includes('cm-z-h2'))).toBe(false);

    fireComposition(view, 'compositionend', '## ');
    await tick();

    expect(decoSnapshot(view).some((s) => s.includes('cm-z-mark'))).toBe(true);
  });

  it('кириллица посимвольно и с автозаменой не даёт символов-призраков', async () => {
    view = makeView('', { selection: { anchor: 0 } });

    fireComposition(view, 'compositionstart');
    // Свайп-ввод: промежуточное слово, затем автозамена целиком его заменяет.
    view.dispatch({ changes: { from: 0, insert: 'превет' }, selection: { anchor: 6 } });
    view.dispatch({
      changes: { from: 0, to: 6, insert: 'привет' },
      selection: { anchor: 6 },
    });
    fireComposition(view, 'compositionend', 'привет');
    await tick();

    expect(view.state.doc.toString()).toBe('привет');
    expect(view.state.doc.toString()).not.toMatch(/превет/);
  });

  it('потеря фокуса во время композиции разблокирует пересчёт', async () => {
    view = makeView('# Заголовок', { selection: { anchor: 0 } });
    fireComposition(view, 'compositionstart');
    expect(isComposing(view)).toBe(true);

    view.contentDOM.dispatchEvent(new Event('blur', { bubbles: true }));
    await tick();

    expect(isComposing(view)).toBe(false);
  });

  it('вне композиции пересчёт идёт как обычно', () => {
    view = makeView('обычный текст', { selection: { anchor: 0 } });
    view.dispatch({ changes: { from: 0, insert: '## ' }, selection: { anchor: 3 } });
    expect(decoSnapshot(view).some((s) => s.includes('cm-z-h2'))).toBe(true);
    expect(compositionDeferrals(view)).toBe(0);
  });
});
