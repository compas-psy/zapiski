/**
 * Переключатель режимов в шапке заметки (замечание 3).
 *
 * ── Что здесь переключается ─────────────────────────────────────────────────
 *
 * Заказчик описал два уровня, и они складываются в три состояния показа:
 *
 *   Простой                — разметки не видно НИКОГДА, даже под курсором.
 *                            Форматируют панелью и хоткеями; это поведение
 *                            Telegram, на который он и ссылался.
 *   Профессиональный       — разметка проявляется в том блоке, где стоит
 *     · Просмотр             курсор, и исчезает, когда курсор ушёл.
 *   Профессиональный       — разметка видна вся и всегда.
 *     · Разметка
 *
 * Второй переключатель показывается только в профессиональном режиме: в
 * простом «показать разметку» означало бы дверь в то, чего человек не выбирал.
 *
 * ── Почему две кнопки, а не сегменты с подписями ────────────────────────────
 *
 * Шапка заметки узкая, и на телефоне рядом уже стоят «назад», «инфо» и «ещё».
 * Сегменты со словами «Простой | Профессиональный» съели бы её целиком.
 * Поэтому символы: глаз — «вижу результат», угловые скобки — «вижу разметку».
 * Состояние читается заливкой, а слова остаются в подсказке и для
 * скринридера — им переключатель обязан представляться словами.
 *
 * Режим — настройка оформления и живёт в теме: он общий для всех заметок и
 * переживает перезапуск. Показ разметки — состояние сессии: это взгляд на
 * текущий текст, а не постоянный выбор.
 */
import type { ReactNode } from 'react';

import { useApp, useAppState, useStrings } from '../state/context.js';
import { useTheme } from '@zapiski/ui';

export function ModeSwitch(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const theme = useTheme();

  const pro = theme.editor.mode === 'pro';
  const rawOn = pro && state.rawMode;

  return (
    <div className="za-modeswitch" role="group" aria-label={strings.settings.editor.mode}>
      <button
        type="button"
        className="za-modeswitch__btn"
        aria-pressed={pro}
        title={pro ? strings.note.modePro : strings.note.modeSimple}
        aria-label={pro ? strings.note.modePro : strings.note.modeSimple}
        onClick={() => {
          const next = pro ? 'simple' : 'pro';
          theme.setEditor({ mode: next });
          /* Уход в простой режим гасит и показ разметки: иначе настройка
             осталась бы включённой невидимо и «выстрелила» при следующем
             возврате в профессиональный. */
          if (next === 'simple' && state.rawMode) app.toggleRawMode(false);
        }}
      >
        {pro ? <GlyphCode /> : <GlyphEye />}
      </button>

      {pro ? (
        <button
          type="button"
          className="za-modeswitch__btn"
          aria-pressed={rawOn}
          title={rawOn ? strings.note.markupHide : strings.note.markupShow}
          aria-label={rawOn ? strings.note.markupHide : strings.note.markupShow}
          onClick={() => app.toggleRawMode(!rawOn)}
        >
          <GlyphMarkup />
        </button>
      ) : null}
    </div>
  );
}

/* Глифы рисуются здесь, а не берутся из набора иконок: в наборе нет ни глаза,
   ни угловых скобок, а заводить их ради одного места — лишний повод потом
   расходиться с ним. Штрих и размер — как у соседей по шапке. */

function GlyphEye(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function GlyphCode(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** «Вся разметка»: те же скобки, но с решёткой — знаком самой разметки. */
function GlyphMarkup(): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.5 5 7 19M17 5l-2.5 14M5 9.5h13.5M4 14.5h13.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
