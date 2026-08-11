/**
 * Системные врезки Android (баг со скриншотов пользователя).
 *
 * Оболочка ставит `viewport-fit=cover`, и это правильно: фон обязан доходить
 * до кромки экрана, иначе сверху появляется чужая полоса другого цвета. Но
 * компенсации не было ни одной — `env(safe-area-inset-*)` встречался ровно в
 * одном месте, в нижнем крае bottom sheet'а. Шапка «Все заметки» и первый
 * экран онбординга уезжали под часы и значок батареи.
 *
 * Отдельно пострадали фиксированные слои: `position: fixed` считает от окна, а
 * не от оболочки, поэтому отступы `.za-app` до них не доходят. Последним
 * пунктом выезжающей библиотеки идут «Настройки» — единственная дорога к ним с
 * телефона, — и он лежал под жестовой полосой. Отсюда и «настройки в принципе
 * не открываются».
 *
 * Проверяется здесь, а не глазами на устройстве, по единственной причине:
 * поймать это в браузере нельзя — на десктопе все врезки равны нулю, и экран
 * выглядит правильным при полностью отсутствующей поддержке.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../..');

function css(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

/** Тело правила по имени класса — чтобы искать врезку в нужном селекторе. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  expect(start, `правило ${selector} не найдено`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end);
}

describe('оболочка приложения отступает от системных панелей', () => {
  const app = css('packages/app/src/styles/app.css');

  it('врезки со всех четырёх сторон', () => {
    const shell = rule(app, '.za-app');
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(shell, side).toContain(`env(safe-area-inset-${side}`);
    }
  });

  it('оболочка считает паддинг внутрь, иначе экран станет выше окна', () => {
    /* `block-size: 100dvh` плюс паддинг без `border-box` — это прокрутка
       всего приложения на высоту статус-бара. */
    const shell = rule(app, '.za-app');
    expect(shell).toContain('box-sizing: border-box');
    expect(shell).toContain('100dvh');
  });
});

describe('фиксированные слои отступают сами', () => {
  const overlay = css('packages/ui/src/components/Overlay/Overlay.css');

  it('выезжающая библиотека: сверху и снизу', () => {
    /* Нижний отступ здесь — не косметика: под жестовой полосой лежала
       кнопка «Настройки». */
    const drawer = rule(overlay, '.z-drawer');
    expect(drawer).toContain('env(safe-area-inset-top');
    expect(drawer).toContain('env(safe-area-inset-bottom');
  });

  it('bottom sheet: снизу', () => {
    expect(rule(overlay, '.z-sheet')).toContain('env(safe-area-inset-bottom');
  });

  it('модалка: сверху и снизу', () => {
    const layer = rule(overlay, '.z-modal-layer');
    expect(layer).toContain('env(safe-area-inset-top');
    expect(layer).toContain('env(safe-area-inset-bottom');
  });

  it('тост: снизу — иначе «Отменить» не нажать пальцем', () => {
    /* Отмена удаления живёт шесть секунд; кнопка под системной панелью
       означает потерянную заметку. */
    expect(rule(overlay, '.z-toast-layer')).toContain('env(safe-area-inset-bottom');
  });
});

describe('Android сообщает о врезках только по просьбе', () => {
  it('манифест просит рисовать под вырезом', () => {
    /* Без `windowLayoutInDisplayCutoutMode` система не отдаёт WebView вырез, и
       `env(safe-area-inset-top)` остаётся нулём при том, что окно занимает
       верх экрана. То есть CSS выше без этой строки бесполезен. */
    const overlayScript = readFileSync(
      resolve(REPO_ROOT, 'apps/mobile/scripts/apply-android-overlay.mjs'),
      'utf8',
    );
    expect(overlayScript).toContain('android:windowLayoutInDisplayCutoutMode');
    expect(overlayScript).toContain('shortEdges');
  });

  it('оболочка рисует под системными панелями', () => {
    expect(readFileSync(resolve(REPO_ROOT, 'apps/mobile/index.html'), 'utf8')).toContain(
      'viewport-fit=cover',
    );
  });
});
