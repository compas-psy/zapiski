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

/* Порядок важен: раньше эти правила стояли инлайном в <head>, то есть ДО
   ссылки на стили приложения, и уступали ей при равной специфичности. Импорт
   первым сохраняет тот же порядок каскада. */
import './shell.css';
import '@zapiski/app/styles.css';

import { createHost } from './host';
import { watchSystemBars } from './platform/system-bars';

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

/* Значки системных панелей — вслед за темой, один раз на окно. Экраны об этом
   не знают и знать не должны: признак ставится окну целиком. */
watchSystemBars();

/*
 * Сборка хоста асинхронна из-за одного поля — биометрии: доступность нужно
 * выяснить ДО первого рендера, иначе тумблер «Использовать отпечаток» либо
 * мигает через секунду, либо обещает то, чего на устройстве нет (см. host.ts).
 *
 * Заметного ожидания это не добавляет: один вызов IPC, а тема уже применена
 * выше, поэтому пустой кадр остаётся тем же самым, что и раньше.
 */
void createHost().then((host) => {
  createRoot(container).render(
    <StrictMode>
      <App host={host} />
    </StrictMode>,
  );
});

