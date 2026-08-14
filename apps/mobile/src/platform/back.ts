/**
 * Системное «назад» на Android: транспорт от активности к приложению.
 *
 * Активность (`android/.../MainActivity.kt`) на каждое нажатие спрашивает
 * WebView одной строкой JavaScript и смотрит на ответ: `true` — приложение
 * шаг назад сделало само, иначе событие уходит системе и человек выходит из
 * приложения.
 *
 * Почему функция на `window`, а не событие Tauri: ответ нужен СИНХРОННО, в тот
 * же момент, когда система решает, закрывать приложение или нет. События IPC
 * асинхронны, и к моменту ответа решение уже принято.
 *
 * Ни одного продуктового решения здесь нет: что считать шагом назад, знает
 * `packages/app` (ARCHITECTURE §1).
 */

/** Имя согласовано с `MainActivity.kt`; больше нигде не встречается. */
const BRIDGE = '__zapiskiSystemBack';

type BackBridge = Record<string, (() => boolean) | undefined>;

export function onSystemBack(handler: () => boolean): () => void {
  const target = window as unknown as BackBridge;
  const bridge = (): boolean => {
    try {
      return handler();
    } catch {
      /* Отказ обработчика не должен запирать человека в приложении: пусть
         сработает системное «назад». */
      return false;
    }
  };
  target[BRIDGE] = bridge;
  return () => {
    /* Снимаем только СВОЙ мост: за время жизни подписки его мог заменить
       следующий монтаж приложения, и затирать его чужой отпиской нельзя. */
    if (target[BRIDGE] === bridge) delete target[BRIDGE];
  };
}
