#!/usr/bin/env node
/**
 * Шлюз production-пути для сборки Windows: кому можно переписывать
 * постоянную ссылку /updates/latest/zapiski-setup.exe.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * P1-аудит closure-pass нашёл: шаг «Отдать установщик на сервер»
 * (build-windows.yml) копировал .exe в `/updates/latest` БЕЗ проверки
 * ветки вовсе — `if: env.HAS_SERVER == 'true'` и больше ничего. Ручной
 * запуск (или push) с ЛЮБОЙ feature-ветки перезаписывал production-ссылку,
 * с которой автообновление и `/promo` раздают установщик всем людям
 * одновременно. Тот же класс дефекта уже был найден и закрыт для Android
 * (`apps/mobile/scripts/android-release-gate.mjs`, `resolveChannel` +
 * `PROMOTED`) — здесь тот же приём: решение «можно ли попасть в
 * production-путь» живёт чистой функцией, а не веткой `if` внутри YAML, и
 * испытывается тестом (`test/windows-release-gate.test.ts`), а не
 * перечитыванием глазами.
 *
 * ── Почему логика здесь, а не в YAML ────────────────────────────────────────
 *
 * В YAML её нельзя проверить матрицей случаев без реального прогона на
 * раннере. Здесь `resolvePromoted` — чистая функция без секретов, без сети,
 * без Windows: та же причина, по которой рядом лежит
 * `msix/build-msix.mjs --self-test`.
 *
 * Запуск из workflow:
 *   node scripts/windows-release-gate.mjs promoted
 */

/**
 * Тот же смысл, что раньше вычислялся ТОЛЬКО в последнем шаге `build` job
 * (`build-windows.yml`, шаг «Установщик должен быть хоть где-то») — здесь он
 * вычисляется РАНЬШЕ, до того как что-либо копируется в `/updates/latest`,
 * а не только для финального отчёта. Формула не изменена: тег ИЛИ ветка по
 * умолчанию — ровно то же условие, что уже стояло в workflow.
 */
export function resolvePromoted({ refType = 'branch', refName = '', defaultBranch = '' } = {}) {
  return refType === 'tag' || (refName !== '' && refName === defaultBranch);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { appendFileSync } = await import('node:fs');
  const [, , command] = process.argv;
  const emit = (line) => {
    console.log(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  };

  if (command === 'promoted') {
    const refType = process.env.GITHUB_REF_TYPE ?? 'branch';
    const refName = process.env.GITHUB_REF_NAME ?? '';
    const defaultBranch = process.env.DEFAULT_BRANCH ?? '';
    const promoted = resolvePromoted({ refType, refName, defaultBranch });
    emit(`promoted=${promoted ? 'true' : 'false'}`);
    console.log(`Ветка/тег: ${refName} (${refType}), ветка по умолчанию: ${defaultBranch}`);
    console.log(`production-путь (/updates/latest): ${promoted ? 'ОТКРЫТ' : 'ЗАКРЫТ'}`);
  } else {
    console.error(`::error::неизвестная команда «${command ?? ''}»: promoted`);
    process.exit(1);
  }
}
