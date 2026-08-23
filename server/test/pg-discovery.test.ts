/**
 * Поиск Postgres для тестов и громкость его отсутствия.
 *
 * ── Что не так было ──────────────────────────────────────────────────────────
 *
 * 22 файла серверных тестов обёрнуты в `describe.skipIf(noDatabase())`. База
 * поднимается эфемерно (`test/helpers/pg.ts`), а если бинарей не нашлось —
 * `globalSetup` печатал `console.warn` и прогон продолжался ЗЕЛЁНЫМ, не
 * проверив ни маршрутов, ни миграций, ни аутентификации.
 *
 * В CI это худший из возможных исходов: шаг «Тесты» показывает успех, а
 * проверено при этом меньше половины. Ровно тот случай, который у нас уже
 * записан правилом «пропуск обязан быть громким».
 *
 * ── Вторая половина: список версий ───────────────────────────────────────────
 *
 * Каталоги искались по ЖЁСТКОМУ списку — 14, 15, 16. Раннеры GitHub переезжают
 * на 17, и в день переезда список перестал бы совпадать. Отказ был бы не
 * «сборка упала», а «тестов стало вдвое меньше, никто не заметил».
 * Поэтому версии теперь не перечисляются, а вычитываются из каталога, и
 * новая версия выигрывает у старой.
 */
import { describe, expect, it } from 'vitest';

import { orderedBinCandidates, requireDatabase } from './helpers/pg.ts';

describe('поиск каталога с initdb', () => {
  it('версии берутся из каталога, а не из зашитого списка', () => {
    const found = orderedBinCandidates(['14', '16', '17', 'не-версия']);
    expect(found).toContain('/usr/lib/postgresql/17/bin');
    expect(found).toContain('/usr/lib/postgresql/16/bin');
  });

  it('новая версия пробуется раньше старой', () => {
    const found = orderedBinCandidates(['14', '17', '15']);
    const numeric = found
      .map((dir) => /postgresql\/(\d+)\/bin$/.exec(dir)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    expect(numeric).toEqual([...numeric].sort((a, b) => b - a));
    expect(numeric[0]).toBe(17);
  });

  it('нечисловые имена каталогов отбрасываются', () => {
    expect(orderedBinCandidates(['мусор', '16'])).not.toContain('/usr/lib/postgresql/мусор/bin');
  });

  it('каталога нет вовсе — остаются запасные пути, а не пустой список', () => {
    expect(orderedBinCandidates([]).length).toBeGreaterThan(0);
  });
});

describe('отсутствие базы: когда это можно пережить, а когда нет', () => {
  it('на машине разработчика — предупреждение, прогон продолжается', () => {
    expect(requireDatabase({})).toBe(false);
  });

  it('в CI — обязательна: молчаливый пропуск половины тестов там недопустим', () => {
    expect(requireDatabase({ CI: 'true' })).toBe(true);
    expect(requireDatabase({ GITHUB_ACTIONS: 'true' })).toBe(true);
  });

  it('CI=false не считается за CI', () => {
    expect(requireDatabase({ CI: 'false' })).toBe(false);
  });

  it('явное разрешение снимает требование — но его надо написать руками', () => {
    expect(requireDatabase({ CI: 'true', ZAPISKI_ALLOW_NO_DATABASE: '1' })).toBe(false);
  });
});
