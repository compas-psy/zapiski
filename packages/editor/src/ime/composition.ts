/**
 * IME и кириллица — регрессионный тест-кейс №1 (BEHAVIOR §2.1).
 *
 * Правило: **перерисовка live-preview откладывается до `compositionend`.**
 * Пока идёт композиция, набор декораций только «сдвигается» вместе с
 * изменениями документа (`DecorationSet.map`) и никогда не пересчитывается.
 * Это критично: CodeMirror сравнивает старый и новый наборы декораций
 * (`findChangedDeco`) и любой изменившийся диапазон внутри композиции заставит
 * его переписать DOM composing-узла — а это ровно те самые «символы-призраки»
 * при автозамене, свайп-вводе и диктовке.
 *
 * Композиция отслеживается двумя независимыми способами, чтобы не зависеть от
 * особенностей конкретной прошивки клавиатуры:
 *   1) собственный флаг по событиям `compositionstart` / `compositionend`;
 *   2) `EditorView.compositionStarted` — внутренний детектор CodeMirror.
 * Достаточно любого из них, чтобы отложить пересчёт.
 */

import { StateEffect } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { PluginValue } from '@codemirror/view';

/**
 * «Композиция закончилась — можно пересчитывать».
 * Диспатчится пустой транзакцией после `compositionend`, чтобы разбудить
 * плагины: сам по себе `compositionend` транзакции не порождает.
 */
export const redecorateEffect = StateEffect.define<null>();

class CompositionGuard implements PluginValue {
  /** Идёт ли композиция прямо сейчас. */
  composing = false;
  /** Сколько раз пересчёт был отложен — читается тестами. */
  deferrals = 0;
  /**
   * Видели ли мы хоть одно событие композиции. Если да — наш флаг становится
   * единственным источником правды: он умеет разблокироваться по `blur`,
   * а внутренний счётчик CodeMirror — нет. Если нет (экзотическая клавиатура,
   * не шлющая `compositionstart`) — доверяем детектору CodeMirror.
   */
  sawEvents = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {}

  start(): void {
    this.composing = true;
    this.sawEvents = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Конец композиции. Сбрасываем флаг и будим редактор отдельной пустой
   * транзакцией в следующем такте: к этому моменту CodeMirror уже применил
   * собственные изменения из `compositionend`.
   */
  end(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.composing = false;
      this.view.dispatch({ effects: redecorateEffect.of(null) });
    }, 0);
  }

  /** Композиция, прерванная потерей фокуса, тоже должна разблокировать пересчёт. */
  abort(): void {
    if (!this.composing) return;
    this.end();
  }

  noteDeferral(): void {
    this.deferrals++;
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const compositionGuard = ViewPlugin.fromClass(CompositionGuard, {
  eventHandlers: {
    compositionstart(this: CompositionGuard) {
      this.start();
      return false;
    },
    compositionend(this: CompositionGuard) {
      this.end();
      return false;
    },
    blur(this: CompositionGuard) {
      this.abort();
      return false;
    },
  },
});

/** Идёт ли композиция IME — единственная точка правды для всех плагинов. */
export function isComposing(view: EditorView): boolean {
  const guard = view.plugin(compositionGuard);
  if (guard?.composing) return true;
  if (guard?.sawEvents) return false;
  return view.compositionStarted;
}

/** Отметить отложенный пересчёт (для диагностики и тестов). */
export function noteDeferral(view: EditorView): void {
  view.plugin(compositionGuard)?.noteDeferral();
}

/** Сколько раз пересчёт откладывался из-за композиции. */
export function compositionDeferrals(view: EditorView): number {
  return view.plugin(compositionGuard)?.deferrals ?? 0;
}

/** Расширение, которое обязано быть подключено рядом с live-preview. */
export const imeSupport: Extension = [compositionGuard];
