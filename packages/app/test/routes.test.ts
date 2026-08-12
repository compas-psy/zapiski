/**
 * Каждый маршрут обязан куда-то вести.
 *
 * Дефект, ради которого написан этот файл: экран справки был готов, покрыт
 * тестом и объявлен в `Route` — но в `App.tsx` не было ни импорта, ни `case`.
 * Нажатие переключало маршрут, `solo` возвращал `null`, и на месте справки
 * оставался список заметок. Со стороны — «кнопка не работает».
 *
 * Почему это не поймал существующий тест справки: он монтировал `HelpScreen`
 * напрямую и проверял его содержимое. Дорогу К экрану так проверить нельзя —
 * тест был зелёный, а до экрана было не добраться. Разрыв между «компонент
 * работает» и «до компонента можно дойти» и сторожится здесь.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../src');
const contract = readFileSync(resolve(SRC, 'contract.ts'), 'utf8');
const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');

/** Имена маршрутов из объединения `Route` в контракте. */
function declaredRoutes(): string[] {
  const union = /export type Route =([\s\S]*?);\n/.exec(contract);
  expect(union, 'в contract.ts не нашёлся тип Route').not.toBeNull();
  const names = [...(union as RegExpExecArray)[1]!.matchAll(/name:\s*'([^']+)'/g)].map(
    (match) => match[1] as string,
  );
  /* Сторож без предмета бесполезен: если разбор сломается, тут будет ноль, и
     проверка ниже пройдёт «успешно», ничего не проверив. */
  expect(names.length).toBeGreaterThan(8);
  return names;
}

describe('каждый объявленный маршрут разбирается в App.tsx', () => {
  it.each(declaredRoutes())('маршрут «%s» кто-то рисует', (name) => {
    /* Два маршрута разбирает не `case`, а сам каркас: заметка — по проверке
       имени, список — веткой `default`, потому что это состояние по умолчанию.
       Требовать от них `case` значило бы требовать переписать каркас. */
    if (name === 'note') {
      expect(app).toContain('state.route.name === "note"');
      return;
    }
    if (name === 'list') {
      expect(app).toContain('<NoteListScreen');
      return;
    }
    expect(
      app.includes(`case "${name}"`),
      `маршрут «${name}» объявлен в contract.ts, но в App.tsx его никто не рисует — ` +
        'переход по нему оставит экран прежним',
    ).toBe(true);
  });

  it('экран справки не только объявлен, но и импортирован', () => {
    /* Отдельной строкой, потому что ломалось именно это: `case` без импорта
       не собрался бы, а импорт без `case` собирается молча. */
    expect(app).toContain('HelpScreen');
  });
});
