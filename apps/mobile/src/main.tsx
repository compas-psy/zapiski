/**
 * Точка входа Android-оболочки. Ровно то, что разрешает ARCHITECTURE §1:
 * собрать `AppHost` и смонтировать `<App host={...} />`.
 *
 * Здесь нет и не может быть ни одного экрана, ни одной кнопки, ни одной
 * строки продуктовой логики. Если чего-то не хватает — не хватает порта в
 * `AppHost`, и добавлять нужно порт.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@zapiski/app';
import { applyAppearance, readStoredAppearance } from '@zapiski/ui';

import '@zapiski/app/styles.css';

import { createHost } from './host';
import { EVENTS, on } from './platform/ipc';

/**
 * Тема применяется до первого рендера: иначе тёмная тема мигает светлым на
 * каждом холодном старте. Значение читается из того же хранилища, в которое
 * его кладёт `packages/app`, — оболочка ничего не решает, только применяет
 * раньше React'а.
 */
function applyThemeEarly(): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyAppearance(document.documentElement, readStoredAppearance(), { prefersDark });
}

const container = document.getElementById('root');
if (container === null) throw new Error('в index.html нет #root');

applyThemeEarly();

const host = createHost();

createRoot(container).render(
  <StrictMode>
    <App host={host} />
  </StrictMode>,
);

/**
 * Быстрая заметка: плитка Quick Settings и виджет «Записать» 1×1 (BEHAVIOR §8).
 *
 * ⚠️ Порт для этого в `AppHost` не объявлен — как и на Windows, где ту же роль
 * играет глобальный хоткей (`apps/desktop/src-tauri/src/platform.rs`).
 * Оболочка делает свою половину: событие доставлено и здесь. Вторая половина —
 * поле в `AppHost`; открывать новую заметку самостоятельно оболочка не может,
 * это продуктовое поведение.
 */
void on<null>(EVENTS.quickNote, () => {
  // Намеренно пусто: подписка держит канал живым и документирует контракт.
  // Как только в `AppHost` появится порт, обработчик станет одной строкой.
});
