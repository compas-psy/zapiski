/**
 * Экранная клавиатура: сколько она занимает снизу.
 *
 * ЗАЧЕМ. Заказчик на живом Android: «панель с маркированным списком, жирным,
 * курсивом и т.д. остаётся ПОД, а не НАД клавиатурой». Так и было: во всём
 * проекте не было ни одного упоминания `visualViewport`, и layout-вьюпорт при
 * появлении клавиатуры не меняется — окно остаётся прежней высоты, а
 * клавиатура просто ложится поверх нижних 40% экрана вместе с тулбаром.
 *
 * Как это лечится. Браузер знает про клавиатуру ровно одно: `visualViewport` —
 * та часть окна, которую видно на самом деле. Разница между ней и окном и есть
 * высота клавиатуры. Пишем её в переменную `--z-keyboard`, а редактор получает
 * на неё нижний отступ — тулбар поднимается ровно на высоту клавиатуры.
 *
 * Со стороны Android этому помогает `android:windowSoftInputMode="adjustResize"`
 * в манифесте (см. `apply-android-overlay.mjs`): без него WebView не сообщает
 * об изменении видимой области вовсе. Нужны обе половины — поэтому здесь
 * значение считается по факту, а не берётся из платформы.
 */
import { useEffect } from 'react';

/** Меньше этого — не клавиатура, а панель браузера или округление. */
const NOISE_PX = 80;

/**
 * Держит `--z-keyboard` в актуальном состоянии, пока приложение живо.
 *
 * Пишется на корневой элемент, а не в состояние React: смена высоты
 * клавиатуры приходит десятками событий за анимацию подъёма, и ререндер на
 * каждое — это заметная дрожь на среднем телефоне.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = typeof window === 'undefined' ? null : window.visualViewport;
    const root = typeof document === 'undefined' ? null : document.documentElement;
    if (!viewport || !root) return;

    const update = (): void => {
      /* `offsetTop` — сдвиг видимой области при зуме; без него на зумленной
         странице получилась бы отрицательная высота. */
      const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
      const inset = hidden > NOISE_PX ? Math.round(hidden) : 0;
      root.style.setProperty('--z-keyboard', `${inset}px`);
    };

    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      root.style.removeProperty('--z-keyboard');
    };
  }, []);
}
