import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Манифест сервера и `package-lock.json` обязаны совпадать, а зависимости —
 * ставиться обычным `npm`.
 *
 * ── Откуда взялась проверка ──────────────────────────────────────────────────
 *
 * Боевой образ API собирается `npm ci` по `server/package-lock.json`
 * (deploy/api.Dockerfile), а весь монорепозиторий на раннере живёт под pnpm по
 * `pnpm-lock.yaml`. Это ДВА РАЗНЫХ набора зависимостей, и проверок, которые
 * трогали бы первый, до сих пор не было ни одной: тесты, типы и сборка PWA
 * идут через pnpm и о `package-lock.json` не знают.
 *
 * Поэтому в `server/package.json` можно было добавить зависимость, увидеть
 * зелёный монорепозиторий целиком — и получить красную выкладку. Ровно это и
 * произошло дважды:
 *
 *   1. пакет добавили в манифест, а lock не перегенерировали — `npm ci`
 *      отказывается работать с рассинхроном по определению;
 *   2. пакет прописали строкой `github:compas-psy/auth#main&path:/packages/id-client`.
 *      Суффикс `&path:` — расширение pnpm. npm его не понимает, честно пишет
 *      `ignoring unknown key "main&path"`, клонирует КОРЕНЬ чужого
 *      монорепозитория, не находит там package.json и падает с ENOENT.
 *
 * Оба раза симптом был один: «Поднять API-стек на сервере» краснеет через
 * девять секунд, а причина видна только в логе сборки образа на сервере.
 *
 * Проверка офлайновая: читаются два файла, сеть не нужна.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(`${here}../package.json`, 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(`${here}../package-lock.json`, 'utf8')) as {
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
};

const root = lock.packages[''];

describe('package-lock.json сервера', () => {
  it('описывает тот же корневой пакет, что и манифест', () => {
    /* Именно на этом `npm ci` и отказывается работать: он не разрешает
       зависимости заново, а ставит ровно то, что записано в lock. */
    expect(root, 'в lock нет записи о корневом пакете').toBeDefined();
    expect(root!.dependencies ?? {}).toEqual(manifest.dependencies ?? {});
    expect(root!.devDependencies ?? {}).toEqual(manifest.devDependencies ?? {});
  });

  it('на каждую зависимость манифеста есть запись в lock', () => {
    const missing = Object.keys(manifest.dependencies ?? {}).filter(
      (name) => lock.packages[`node_modules/${name}`] === undefined,
    );
    expect(missing, `в lock нет записей: ${missing.join(', ')}`).toEqual([]);
  });

  it('ни одна зависимость не ставится из git', () => {
    /* Прод-образ ставит зависимости обычным npm и без доступа к GitHub.
       Синтаксис pnpm с подкаталогом (`#ref&path:/…`) он не понимает вовсе —
       такую строку нельзя ни поставить, ни диагностировать по логу CI. */
    const all = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    const fromGit = Object.entries(all).filter(([, spec]) =>
      /^(github:|git\+|git:)/.test(spec) || spec.includes('&path:'),
    );
    expect(fromGit.map(([name]) => name), 'зависимости из git в образ не ставятся').toEqual([]);
  });
});
