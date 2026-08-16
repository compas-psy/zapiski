import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Где искать браузер — одно место на все прогоны.
 *
 * ── Почему это отдельный файл ───────────────────────────────────────────────
 *
 * Жёсткий путь — ошибка: у разработчика, в песочнице агента и на раннере CI
 * браузер лежит в трёх разных местах. Пока поиск копировался из скрипта в
 * скрипт, копии разъезжались: свежий прогон экрана входа знал только путь
 * песочницы и в CI честно сказал «браузера нет» — то есть со `--strict` уронил
 * выкладку на пустом месте, ничего не проверив.
 *
 * Отсюда общий модуль: правило поиска ровно одно, и новый прогон получает его
 * импортом, а не копипастой.
 */
/**
 * Окружение для браузера — одно на все прогоны.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * Chromium переводит имена файлов между строкой JS и файловой системой через
 * ЛОКАЛЬ процесса. В контейнере агента локаль — `POSIX`, и тогда в OPFS не
 * создаётся ни один файл с русским именем: `getFileHandle('Заметка.md')`
 * отвечает «path exists, but was not an entry of requested type», хотя каталог
 * пуст. Латиница при этом проходит.
 *
 * Продукт к этому отношения не имеет, а сквозной прогон падал именно так:
 * «после онбординга не открылся редактор» — потому что первая заметка
 * называется «Без названия.md». Сторож, который врёт о причине, хуже
 * отсутствующего: этот на полдня увёл поиск в OPFS и веб-хранилище.
 *
 * Поэтому браузер запускается с явной UTF-8 локалью — как на машине человека.
 */
export function browserEnv() {
  return { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
}

export function findChrome() {
  /* Заданный вручную путь тоже проверяется: иначе опечатка в переменной даёт
     не понятное сообщение, а стек из глубины Playwright. */
  if (process.env.ZAPISKI_CHROME) {
    return existsSync(process.env.ZAPISKI_CHROME) ? process.env.ZAPISKI_CHROME : null;
  }

  /* Браузеры Playwright: версия в имени каталога меняется от обновления к
     обновлению, поэтому каталог перебирается, а не прописывается. */
  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (existsSync(pool)) {
    for (const entry of readdirSync(pool).sort().reverse()) {
      for (const tail of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = join(pool, entry, tail);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  /* Системные сборки — то, что есть на раннерах GitHub. */
  for (const candidate of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
