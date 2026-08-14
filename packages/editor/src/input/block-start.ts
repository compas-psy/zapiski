/**
 * Две вещи, из-за которых курсор в тексте вёл себя не так, как ждут.
 *
 * ── 1. Enter перед первой буквой заголовка ──────────────────────────────────
 *
 * Заказчик: «если в редакторе в простом режиме поставлю курсор перед первой
 * буквой, например, Заголовка1 и нажму Enter, то каретка перенесётся вместе со
 * строкой вниз, но и форматирование потеряется. Это происходит потому, что "#"
 * остался выше, а пользователь этого не видит».
 *
 * Он прав целиком, причину назвал верно. В простом режиме решётка спрятана, и «начало
 * строки» на экране — это позиция ПОСЛЕ неё. Обычный перевод строки делит
 * строку ровно там: сверху остаётся осиротевшая `# `, снизу — бывший заголовок
 * без разметки. Человек видит, как заголовок превратился в обычный текст, и не
 * видит ни одной причины.
 *
 * Как это делают там, где разметка тоже спрятана (Notion, Obsidian в режиме
 * просмотра): Enter в начале блока добавляет пустую строку СВЕРХУ, а сам блок
 * остаётся собой. Здесь так же.
 *
 * ── 2. Место под картинкой ──────────────────────────────────────────────────
 *
 * Заказчик: «когда вставил картинку, перевести каретку под неё можно только
 * нажав Enter на строке выше».
 *
 * Причина той же породы. Картинка рисуется виджетом, а разметка строки скрыта:
 * на экране под изображением нет ничего, куда можно ткнуть, — и если картинка
 * последняя в заметке, продолжить писать нечем. Ткнуть ниже текста и начать
 * писать — то, что делает любой редактор; для этого нужна строка, и мы её
 * заводим по требованию, а не держим в файле заранее.
 */
import type { StateCommand } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { editorModeOf } from '../live-preview/editor-mode.js';

/**
 * Разметка блока, которую простой режим прячет целиком: заголовок и цитата.
 *
 * Списки сюда не входят намеренно: у них своё поведение на Enter (новый пункт,
 * выход из списка на пустом), и оно уже написано в `input/lists.ts`. Две
 * команды на одну клавишу спорили бы за один и тот же случай.
 */
const BLOCK_PREFIX = /^(#{1,6}[ \t]+|>[ \t]?)/;

/**
 * Enter, когда курсор стоит на видимом начале размеченной строки: пустая
 * строка сверху, разметка цела.
 */
export const enterAtBlockStart: StateCommand = ({ state, dispatch }) => {
  /* В профессиональном режиме решётка видна: человек сам видит, где стоит
     курсор, и обычное поведение его не обманывает. */
  if (editorModeOf(state) !== 'simple') return false;

  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  const prefix = BLOCK_PREFIX.exec(line.text)?.[1];
  if (prefix === undefined) return false;
  /* Только ровно на границе разметки: внутри текста Enter обязан делить строку
     как обычно. */
  if (range.head !== line.from + prefix.length) return false;

  dispatch(
    state.update({
      changes: { from: line.from, insert: '\n' },
      /* Курсор остаётся при своём заголовке — тот просто уехал строкой ниже. */
      selection: { anchor: range.head + 1 },
      userEvent: 'input',
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Поставить курсор в конец заметки, заведя пустую строку, если последняя
 * строка занята.
 *
 * Отдельной командой, а не внутри обработчика мыши: так поведение проверяемо
 * без раскладки — в тестовой среде её нет вовсе.
 */
export const caretAtTail: StateCommand = ({ state, dispatch }) => {
  const last = state.doc.line(state.doc.lines);
  if (last.text.length === 0) {
    if (state.selection.main.empty && state.selection.main.head === last.from) return false;
    dispatch(state.update({ selection: { anchor: last.from }, scrollIntoView: true }));
    return true;
  }
  dispatch(
    state.update({
      changes: { from: state.doc.length, insert: '\n' },
      selection: { anchor: state.doc.length + 1 },
      userEvent: 'input',
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Нажатие ниже последней строки ставит курсор в конец текста.
 *
 * Проверка по координатам, а не по попаданию в текст: клик в пустое поле
 * слева или справа от строки — обычное дело и не должен ничего дописывать.
 * Условие одно и строгое: щёлкнули НИЖЕ последней строки.
 */
export const tailClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.detail > 1) return false;
    const end = view.coordsAtPos(view.state.doc.length);
    if (!end || event.clientY <= end.bottom) return false;
    caretAtTail({ state: view.state, dispatch: (tr) => view.dispatch(tr) });
    view.focus();
    return true;
  },
});
