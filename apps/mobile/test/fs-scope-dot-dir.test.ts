/**
 * Служебный каталог `.zapiski` обязан быть доступен плагину `fs`.
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * На Android каталог приложения не работал ВООБЩЕ — ни одной заметки в него
 * нельзя было сохранить. Приложение говорило «Папка недоступна» о папке,
 * которую само же секунду назад создало.
 *
 * Механика отказа, по исходникам, а не по догадке:
 *
 *  1. `vault_open` (src-tauri/src/vault.rs) выдаёт корень в рантайм-скоуп:
 *     `app.fs_scope().allow_directory(&root, true)`. Это заводит два шаблона —
 *     `<root>` и `<root>/**` (tauri 2.11.5, src/scope/fs.rs, `allow_directory`).
 *  2. Сопоставление идёт `glob`-ом с опцией `require_literal_leading_dot`.
 *     Значение по умолчанию — `cfg!(unix)`, то есть на Android **true**
 *     (tauri-plugin-fs 2.5.1, src/commands.rs: `.unwrap_or(cfg!(unix))`;
 *     tauri 2.11.5, src/scope/fs.rs: `#[cfg(unix)] _ => true`).
 *  3. При `true` шаблон `**` не совпадает с компонентой, начинающейся с точки.
 *     Значит `<root>/.zapiski` не покрыт НИ ОДНИМ шаблоном → плагин отвечает
 *     `forbidden path: …/Записки/.zapiski`.
 *
 * А в `.zapiski/` лежит вся служебная часть хранилища: снимок индекса, журнал
 * корзины, логи CRDT, история версий и каталог `tmp`, через который идёт
 * атомарная запись. Отсюда и полная неработоспособность: `writeAtomic` первым
 * делом зовёт `ensureDir` → `storage.mkdir('.zapiski')` → отказ.
 *
 * Коварство было в том, что отказ выглядел как «нет доступа к папке
 * пользователя», хотя папка была на месте, пустая и только что созданная нами.
 *
 * ── Правило, которое здесь сторожится ───────────────────────────────────────
 *
 * Если хоть один служебный путь хранилища начинается с точки — оболочка,
 * работающая через плагин `fs`, ОБЯЗАНА снять `requireLiteralLeadingDot`.
 * Иначе часть собственного хранилища для приложения не существует.
 *
 * Проверка falsifiable: уберите `plugins.fs` из `tauri.conf.json` — тест
 * покраснеет; переименуйте `META_DIR` в каталог без точки — требование
 * снимется само.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { META_DIR } from '@zapiski/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/**
 * Оболочки, которые ходят в хранилище через `@tauri-apps/plugin-fs`.
 *
 * Веба здесь нет: он работает через OPFS и File System Access, у которых
 * скрытых имён не существует вовсе.
 */
const SHELLS = [
  ['Android', 'apps/mobile/src-tauri/tauri.conf.json'],
  ['Windows', 'apps/desktop/src-tauri/tauri.conf.json'],
] as const;

/**
 * Служебные пути хранилища — все, что оболочка создаёт САМА, а не по просьбе
 * пользователя. Список ведётся руками намеренно: появление здесь нового
 * скрытого каталога — повод перечитать этот тест, а не молча его расширить.
 */
const SERVICE_PATHS = [META_DIR, `${META_DIR}/tmp`, `${META_DIR}/crdt`, `${META_DIR}/versions`];

function hidden(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

describe('служебный каталог хранилища доступен плагину fs', () => {
  it('в служебных путях есть скрытые компоненты — значит требование в силе', () => {
    /* Если это когда-нибудь перестанет быть правдой, требование ниже станет
       беспредметным, и тест обязан сказать об этом, а не молча зеленеть. */
    expect(SERVICE_PATHS.filter(hidden), 'скрытых служебных путей не осталось').not.toHaveLength(0);
  });

  for (const [shell, config] of SHELLS) {
    it(`${shell}: requireLiteralLeadingDot снят`, () => {
      const parsed = JSON.parse(readFileSync(join(REPO, config), 'utf8')) as {
        plugins?: { fs?: { requireLiteralLeadingDot?: boolean } };
      };
      const value = parsed.plugins?.fs?.requireLiteralLeadingDot;

      expect(
        value,
        `${config}: без plugins.fs.requireLiteralLeadingDot = false плагин ` +
          `отвечает «forbidden path» на ${META_DIR} — половина хранилища ` +
          'перестаёт существовать для приложения',
      ).toBe(false);
    });
  }
});
