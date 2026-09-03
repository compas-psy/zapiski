/**
 * То же правило, но для набора руками.
 *
 * ── Чего не хватило первой починке ──────────────────────────────────────────
 *
 * Заказчик пожаловался дважды. Сначала: «выбрал маркированный список — и весь
 * текст выше стал заголовком». Это чинилось в команде, и починилось. Потом:
 * «ошибка с напечатал + ":" + Enter не исчезла». И он прав: кнопка — не
 * единственный способ поставить дефис. Ещё в первом письме было сказано прямо:
 * «пришлось ещё раз нажать Enter, чтобы при наборе "-" текст не укрупнялся».
 *
 * Причина та же самая: строка из дефисов под абзацем — это подчёркивание
 * заголовка (CommonMark, setext), а пустой пункт списка абзац прервать не
 * может. Разница только в том, кто ставит дефис: кнопка или палец.
 *
 * ── Почему правило одно на два пути ─────────────────────────────────────────
 *
 * `needsBlankLineBefore` берётся из `syntax/block-boundary.ts` — единого
 * владельца всей семантики «нужна ли пустая строка» (BEHAVIOR MVP §8): тот же
 * предикат использует и кнопка через `commands/formatting.ts`, и `lists.ts`.
 * Скопировать его сюда значило бы завести вторую редакцию правила, и однажды
 * они разъедутся: одну поправят, другую забудут. Ровно так у нас уже
 * случилось с Т-Кассой.
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { needsBlankLineBefore } from '../syntax/block-boundary.js';

/** Маркеры, которые в одиночку на строке читаются как подчёркивание. */
const MARKERS = new Set(['-', '*', '+']);

export const setextGuard: Extension = EditorView.inputHandler.of((view, from, to, text) => {
  if (!MARKERS.has(text)) return false;

  const line = view.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const after = line.text.slice(to - line.from);
  /* Символ обязан быть первым и единственным на строке: внутри слова дефис
     это дефис, и трогать его нельзя. */
  if (before.trim() !== '' || after.trim() !== '') return false;

  if (!needsBlankLineBefore(view.state, line.number, `${before}${text}`)) return false;

  const changes = view.state.changes([
    { from: line.from, to: line.from, insert: '\n' },
    { from, to, insert: text },
  ]);
  view.dispatch({
    changes,
    selection: view.state.selection.map(changes, 1),
    userEvent: 'input.type',
    scrollIntoView: true,
  });
  return true;
});
