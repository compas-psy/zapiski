/**
 * Шлюз production-пути сборки Windows — P1-аудит closure-pass.
 *
 * ── Что нашли ────────────────────────────────────────────────────────────
 *
 * `build-windows.yml`, шаг «Отдать установщик на сервер», копировал .exe в
 * `/updates/latest/zapiski-setup.exe` — постоянную ссылку, с которой
 * автообновление и `/promo` раздают установщик всем людям, — без единой
 * проверки ветки: единственное условие было `env.HAS_SERVER == 'true'`.
 * Ручной запуск (или push) с ЛЮБОЙ feature-ветки перезаписывал production.
 * Тот же класс дефекта уже закрыт для Android (`android-release-gate.mjs`,
 * `resolveChannel`) — здесь то же решение: чистая функция вместо ветвления
 * внутри YAML.
 *
 * Инвариант, который обязаны доказывать тесты ниже (дословно из задания):
 *   feature branch → build проходит, artifact/builds сохраняются,
 *                     latest НЕ трогается;
 *   default branch → latest обновляется;
 *   tag v*          → release/latest работает;
 *   никакой branch-specific run не может перезаписать production download.
 */
import { describe, expect, it } from 'vitest';
import { resolvePromoted } from '../scripts/windows-release-gate.mjs';

describe('production-путь (/updates/latest) открывается только promoted-сборке', () => {
  it('feature-ветка (push, PR, ручной запуск) — production-путь закрыт', () => {
    expect(
      resolvePromoted({ refType: 'branch', refName: 'feature/x', defaultBranch: 'main' }),
    ).toBe(false);
    expect(
      resolvePromoted({
        refType: 'branch',
        refName: 'claude/task-from-package-9if81j',
        defaultBranch: 'claude/cloud-deployment-cross-platform-9nenw7',
      }),
    ).toBe(false);
  });

  it('ветка по умолчанию — production-путь открыт: её сборки предлагает автообновление и /promo', () => {
    expect(
      resolvePromoted({
        refType: 'branch',
        refName: 'claude/cloud-deployment-cross-platform-9nenw7',
        defaultBranch: 'claude/cloud-deployment-cross-platform-9nenw7',
      }),
    ).toBe(true);
  });

  it('тег — production-путь открыт (та же формула, что уже была в workflow, не сужена до v*)', () => {
    expect(resolvePromoted({ refType: 'tag', refName: 'v0.2.0', defaultBranch: 'main' })).toBe(
      true,
    );
    /* Отдельная проверка «тег совпадает с версией» (`startsWith(ref,
       'refs/tags/v')` в workflow) — это другой шаг, не про PROMOTED: тег
       без `v`-префикса теоретически возможен (ручной служебный тег) и по
       той же формуле, что стояла в workflow исходно, тоже promoted. */
    expect(resolvePromoted({ refType: 'tag', refName: 'smoke-test', defaultBranch: 'main' })).toBe(
      true,
    );
  });

  it('совпадение имени ветки с default branch не в результате подмены пустой строки', () => {
    /* Обе пустые строки не должны молча совпасть — иначе ветка без имени
       (теоретически) считалась бы promoted просто потому, что defaultBranch
       тоже не задан. */
    expect(resolvePromoted({ refType: 'branch', refName: '', defaultBranch: '' })).toBe(false);
  });

  it('pull_request с чужой ветки — production-путь закрыт независимо от имени PR-ветки', () => {
    expect(
      resolvePromoted({ refType: 'branch', refName: 'pull/42/merge', defaultBranch: 'main' }),
    ).toBe(false);
  });
});
