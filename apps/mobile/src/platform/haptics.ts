/**
 * `HapticProvider` — деликатная хэптика Android (BEHAVIOR §0).
 *
 * Правило спецификации, которое здесь важнее кода:
 *
 *   лёгкий импульс — отметка чекбокса, срабатывание свайпа, успешная
 *                    разблокировка, срабатывание long-press;
 *   средний        — удаление и архивация;
 *   ничего         — скролл, набор текста, переключение вкладок.
 *
 * Оболочка **не решает**, когда вибрировать: она только исполняет `impact()`.
 * Места вызова живут в `packages/app` — иначе Windows и веб получили бы другой
 * набор реакций, а это ровно то расхождение платформ, которое запрещено
 * ARCHITECTURE §1.
 */
import type { HapticProvider, HapticStrength } from '@zapiski/core';

import { COMMANDS, call } from './ipc';

export function createHaptics(): HapticProvider {
  return {
    impact(strength: HapticStrength): void {
      // Порт синхронный, вибрация асинхронна. Ошибку глотаем осознанно: на
      // устройстве без вибромотора (или с выключенной тактильной отдачей в
      // настройках ОС) отсутствие импульса — не повод показывать что-либо
      // пользователю.
      void call<void>(COMMANDS.hapticImpact, { strength }).catch(() => undefined);
    },
  };
}
