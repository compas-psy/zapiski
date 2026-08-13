/**
 * Какая картинка сейчас выделена под изменение размера.
 *
 * Заказчик: «масштабирование должно быть по месту, без открытия на полный
 * экран: кликнул на изображении → появились квадратики в углах, за которые
 * можно потянуть → тянешь и меняется размер».
 *
 * Выделение — состояние ПОКАЗА, а не текста: в файле от него не остаётся
 * ничего, и заметка, открытая в чужом редакторе, выглядит так же. Отсюда поле
 * состояния, как у свёрнутых блоков.
 *
 * Ключ — путь к файлу, а не позиция. Позиция уехала бы от правки соседнего
 * текста, а путь у картинки один и тот же, где бы она в заметке ни стояла.
 * Плата: две вставки одного файла в одной заметке выделятся вместе. Это
 * честнее, чем ручки, съезжающие на чужую картинку.
 */
import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';

/** Выделить картинку по пути; `null` — снять выделение. */
export const selectImage = StateEffect.define<string | null>();

export const selectedImageField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(selectImage)) return effect.value;
    /* Каретку поставили в текст — выделение снимается: ручки поверх абзаца,
       который правят, только мешают. Правка документа выделение сохраняет:
       ширина как раз и меняется правкой подписи. */
    if (tr.selection) return null;
    return value;
  },
});

/** Путь выделенной картинки или `null`. */
export function selectedImage(state: EditorState): string | null {
  return state.field(selectedImageField, false) ?? null;
}

export const imageSelection: Extension = [selectedImageField];
