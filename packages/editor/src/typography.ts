/**
 * Настройки типографики (DESIGN_TOKENS §2, BEHAVIOR §10).
 *
 * Все пять настроек — МНОЖИТЕЛИ НАД ТОКЕНАМИ, а не отдельные наборы значений:
 * задаются CSS-переменными на корне редактора, поэтому меняются мгновенно,
 * без переконфигурации состояния и без «белой вспышки».
 */

import { Compartment } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fontFamily } from './theme/tokens.js';

/** Пять ступеней кегля (DESIGN_TOKENS §2). */
export type FontSizeStep = 14 | 15 | 16 | 18 | 20;
/** Три ступени интерлиньяжа. */
export type LineHeightStep = 1.45 | 1.65 | 1.85;
/** Ширина колонки: 640 / 720 / вся ширина. */
export type ColumnWidth = 640 | 720 | 'full';

export interface TypographySettings {
  size: FontSizeStep;
  lineHeight: LineHeightStep;
  column: ColumnWidth;
  /** sans (Golos Text) ↔ serif (Source Serif 4). */
  family: 'sans' | 'serif';
  /** Компактный режим: плотнее кегль, интерлиньяж и поля. */
  compact: boolean;
  /**
   * Оформление списков (замечание 10). Сюда попадает только показ: символ
   * маркера — это текст файла, и его выбирает команда вставки, а не тема.
   */
  listIndent?: 'none' | 'normal' | 'wide';
  listMarkColor?: 'muted' | 'text' | 'accent';
  /**
   * Поля по бокам текста (настройка «Поля»).
   *
   * `wide` — прежнее значение, `medium` — половина от него, `narrow` —
   * четверть. Второе слагаемое тех же полей — отступ колонки в приложении, и
   * множитель у них общий: разъехаться они не могут.
   */
  margins?: 'wide' | 'medium' | 'narrow';
}

export const defaultTypography: TypographySettings = {
  size: 16,
  lineHeight: 1.65,
  column: 640,
  family: 'sans',
  compact: false,
  listIndent: 'normal',
  listMarkColor: 'muted',
  margins: 'medium',
};

/** Сдвиг пунктов списка вправо. `none` — вровень с абзацем. */
const LIST_INDENT = { none: '0px', normal: '24px', wide: '40px' } as const;
/** Цвет маркера и номера. Приглушённый — умолчание, акцентный — по желанию. */
const LIST_MARK_COLOR = {
  muted: 'var(--text-secondary)',
  text: 'var(--text)',
  accent: 'var(--accent)',
} as const;

/** Во сколько раз поле у́же прежнего. `wide` — прежнее, то есть единица. */
const MARGIN_SCALE = { wide: 1, medium: 0.5, narrow: 0.25 } as const;

/** Компактный множитель: 16 → 14.5, 1.65 → 1.5 (DESIGN_TOKENS §2). */
const COMPACT_SIZE = 0.906;
const COMPACT_LINE = 0.909;

export function typographyStyle(settings: TypographySettings): string {
  const size = settings.compact ? settings.size * COMPACT_SIZE : settings.size;
  const line = settings.compact ? settings.lineHeight * COMPACT_LINE : settings.lineHeight;
  const column = settings.column === 'full' ? 'none' : `${settings.column}px`;
  // Serif-режим по токенам крупнее на один шаг: 16 → 17 (DESIGN_TOKENS §2).
  const family = settings.family === 'serif' ? fontFamily.serif : fontFamily.sans;
  const familyScale = settings.family === 'serif' ? 1.0625 : 1;
  const padY = settings.compact ? 24 : 36;
  const padX = (settings.compact ? 20 : 32) * MARGIN_SCALE[settings.margins ?? 'medium'];

  return [
    `--z-fs: ${(size * familyScale).toFixed(2)}px`,
    `--z-lh: ${line.toFixed(3)}`,
    `--z-col: ${column}`,
    `--z-face: ${family}`,
    `--z-pad-y: ${padY}px`,
    `--z-pad-x: ${Math.round(padX)}px`,
    `--z-block-gap: ${settings.compact ? '0.4em' : '0.6em'}`,
    `--z-list-indent: ${LIST_INDENT[settings.listIndent ?? 'normal']}`,
    `--z-list-mark-color: ${LIST_MARK_COLOR[settings.listMarkColor ?? 'muted']}`,
  ].join('; ');
}

const typographyCompartment = new Compartment();

function attributes(settings: TypographySettings): Extension {
  return EditorView.editorAttributes.of({ style: typographyStyle(settings) });
}

/** Расширение с начальными настройками типографики. */
export function typography(settings: TypographySettings = defaultTypography): Extension {
  return typographyCompartment.of(attributes(settings));
}

/** Применить новые настройки на лету (BEHAVIOR §10: мгновенно, без «Применить»). */
export function applyTypography(view: EditorView, settings: TypographySettings): void {
  view.dispatch({ effects: typographyCompartment.reconfigure(attributes(settings)) });
}
