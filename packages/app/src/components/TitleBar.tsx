/**
 * Своя строка заголовка окна (ITERATION-1 §6).
 *
 * Дефект: иконка и название приложения показывались дважды — в системной
 * строке заголовка Windows и в сайдбаре. Референсы Todoist и Bear решают это
 * одинаково: системной строки нет вовсе, окно безрамочное, а бренд живёт
 * ровно в одном месте — в сайдбаре.
 *
 * Знака и вордмарка здесь нет намеренно. Панель задач и Alt+Tab показывают
 * иконку приложения — этого достаточно, чтобы окно было узнаваемо, и
 * дублировать её внутри интерфейса не нужно.
 *
 * Компонент рисуется, только если платформа отдала порт управления окном.
 * У веба и Android его нет: у первого нет окна, у второго строку ведёт
 * система. Скрытый элемент честнее выключенного (BEHAVIOR §5.1).
 */
import { useEffect, useState, type ReactNode } from 'react';

import { useApp, useStrings } from '../state/context.js';

export function TitleBar(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const controls = app.host.platform.window ?? null;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    void controls.isMaximized().then(setMaximized);
    return controls.onMaximizeChange(setMaximized);
  }, [controls]);

  if (!controls) return null;

  /*
   * macOS рисует кнопки окна сам.
   *
   * Там полосы заголовка нет (`titleBarStyle: Overlay`), но три системные
   * кнопки слева остались — убрать их нельзя, иначе окно не закрыть мышью.
   * Свои рядом были бы вторым комплектом, поэтому здесь остаётся только то,
   * за что окно тянут, и поле под «светофор», чтобы содержимое не уезжало
   * под него.
   *
   * Признак приходит из порта окна, а не выводится из системы: это свойство
   * ОКНА и меняется вместе с его конфигурацией.
   */
  const native = controls.chrome === 'native-overlay';

  return (
    <div
      className="za-titlebar"
      /* Вся полоса тянет окно. Кнопки исключены атрибутом ниже — иначе
         нажатие на «закрыть» начинало бы перетаскивание. */
      data-tauri-drag-region="true"
      onDoubleClick={() => void controls.toggleMaximize()}
      style={
        controls.inlineStartInset > 0
          ? { paddingInlineStart: `${controls.inlineStartInset}px` }
          : undefined
      }
    >
      <span className="za-titlebar__space" data-tauri-drag-region="true" />
      {native ? null : (
      <div className="za-titlebar__controls">
        <button
          type="button"
          className="za-titlebar__button"
          aria-label={strings.window.minimize}
          onClick={() => void controls.minimize()}
        >
          <MinimizeGlyph />
        </button>
        <button
          type="button"
          className="za-titlebar__button"
          aria-label={maximized ? strings.window.restore : strings.window.maximize}
          onClick={() => void controls.toggleMaximize()}
        >
          {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
        </button>
        <button
          type="button"
          className="za-titlebar__button za-titlebar__button--close"
          aria-label={strings.window.close}
          onClick={() => void controls.close()}
        >
          <CloseGlyph />
        </button>
      </div>
      )}
    </div>
  );
}

/*
 * Глифы кнопок окна — линиями 1 px, как рисует их сама Windows. Своих иконок
 * из библиотеки здесь нет намеренно: у них скругления и толщина 1.75, и рядом
 * с системными кнопками соседних окон это читалось бы как чужой элемент.
 */
const GLYPH = { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': true } as const;

function MinimizeGlyph(): ReactNode {
  return (
    <svg {...GLYPH}>
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph(): ReactNode {
  return (
    <svg {...GLYPH}>
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** Развёрнутое окно: два прямоугольника уступом — знак «вернуть размер». */
function RestoreGlyph(): ReactNode {
  return (
    <svg {...GLYPH}>
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseGlyph(): ReactNode {
  return (
    <svg {...GLYPH}>
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
