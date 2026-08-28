/**
 * Точка входа оболочки Windows — и это весь её фронтенд.
 *
 * Здесь нет ни одного экрана и ни одной кнопки: `<App>` из `@zapiski/app`
 * содержит ВСЕ экраны и всё поведение, одинаковые на Windows, Android и в
 * вебе (ARCHITECTURE §1). Оболочка делает ровно четыре вещи:
 *
 *   1) собирает `AppHost` из платформенных портов;
 *   2) монтирует `<App host={...} />`;
 *   3) показывает окно, когда первый кадр уже нарисован;
 *   4) заводит то, что живёт вне окна: трей, глобальный хоткей, обновления.
 */
import { invoke } from '@tauri-apps/api/core';
import { App } from '@zapiski/app';
import { createRoot } from 'react-dom/client';

import { createDesktopShell } from './platform/host';
import { initTray, onQuickNote } from './platform/tray';
import { scheduleUpdateChecks } from './platform/updater';

/* Задержка для всего, что не нужно в первом кадре. Холодный старт по ТЗ §6 —
   меньше 2 с, и тратить их на трей и сеть нельзя. */
const AFTER_FIRST_PAINT_MS = 200;

async function start(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('нет контейнера #root');

  const shell = await createDesktopShell();

  /* StrictMode здесь намеренно нет. Он вызывает эффекты дважды, а эффекты
     приложения — это открытие vault'а, регистрация хоткея и таймер
     автозамка: удваивать их в собранном приложении незачем, а поймать
     ошибки двойного вызова есть кому — веб-оболочка и тесты пакетов. */
  createRoot(container).render(<App host={shell.host} locale={shell.locale} />);

  /* Окно скрыто до этого момента (`tauri.conf.json` → `visible: false`):
     показываем его после первого кадра, уже в нужной теме и в сохранённых
     координатах.

     Два кадра, а не один: `render()` только ставит работу в очередь, и
     обработчик первого rAF может выполниться раньше, чем React закоммитит
     дерево. Второй кадр наступает уже после отрисовки — окно открывается на
     готовой картинке, а не на пустом белом прямоугольнике.

     Если сигнал так и не придёт (упал бандл), окно через 2,5 с покажет сам
     Rust — см. `arm_reveal_fallback`. */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void invoke('shell_ready');
    });
  });

  window.setTimeout(() => {
    void afterFirstPaint(shell);
  }, AFTER_FIRST_PAINT_MS);
}

async function afterFirstPaint(shell: Awaited<ReturnType<typeof createDesktopShell>>): Promise<void> {
  /* Трей: подписи приходят отсюда, само меню строит Rust. */
  await initTray(shell.strings).catch(() => {
    /* Иконка в трее не появилась — приложение работает как обычное окно. */
  });

  /* Глобальный хоткей быстрой заметки (BEHAVIOR §7). Занимаем сочетание из
     настроек: оно должно работать и когда окно свёрнуто, и когда приложение
     стартовало в трей. Как только `packages/app` зарегистрирует своё —
     оболочка своё снимет. */
  await shell.hotkey.bootDefault(shell.hotkeyAccelerator);

  /* ⚠️ Событие «быстрая заметка» из трея доходит до оболочки, но передать его
     приложению нечем: в `AppHost` нет порта для этого (ассоциация `.md` уже
     получила свой — `platform/host.ts`). Пока обработчик пустой, и это видно
     в коде, а не спрятано за молчанием (ARCHITECTURE §1: «не хватает порта —
     добавляется порт, а не экран»). */
  await onQuickNote(() => {});

  /* Обновления: проверка при старте и раз в сутки, установка — с согласия
     пользователя (системный диалог, своих экранов у оболочки нет). */
  scheduleUpdateChecks(shell.updater, shell.strings);
}

void start();
