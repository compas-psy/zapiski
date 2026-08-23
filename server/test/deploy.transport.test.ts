/**
 * Файлы на сервер едут через `rsync -e ssh`, а не через `scp`.
 *
 * ── Как это выяснилось ──────────────────────────────────────────────────────
 *
 * Сборка Android вставала на выкладке два прогона подряд (188 и 189). Приборы
 * в шаге показали, что стоит ровно передача APK:
 *
 *     → приём ключа хоста (ssh-keyscan)          0,3 с
 *     → создание каталога сборки на сервере       3,2 с
 *     → передача APK (28M)                        встала, код 124
 *
 * Соблазн был списать на сеть — «большой файл не проходит, чёрная дыра MTU».
 * Опровергается одним фактом, который лежал рядом и ничего не стоил: в те же
 * минуты, на тот же сервер, тем же ключом успешно ходил деплой веба
 * (`deploy-zapiski.yml`, прогоны 176 и 177 — те же коммиты, на которых Android
 * вставал). Он передаёт больше, и он не падал НИ РАЗУ.
 *
 * Разница между ними ровно одна: веб ходит `rsync -az -e "ssh …"`, Android
 * ходил `scp`.
 *
 * ── Причина ─────────────────────────────────────────────────────────────────
 *
 * `scp` начиная с OpenSSH 9.0 передаёт файлы **через подсистему SFTP**, а не
 * старым протоколом. `rsync -e ssh` и `ssh "cat > файл"` работают через
 * обычный exec-канал и подсистемы не касаются. Значит на сервере `Subsystem
 * sftp` не отвечает — отключён при закалке или не установлен. Интерактивный
 * ssh при этом работает, поэтому сервер выглядит живым, а передача стоит
 * молча до потолка.
 *
 * ── Правило ─────────────────────────────────────────────────────────────────
 *
 * Ни одного `scp` в workflow. Файл на сервер и с сервера — `rsync -e ssh`.
 * Правило дешёвое: `rsync` уже стоит на сервере (им пользуется деплой веба) и
 * умеет `--partial`, то есть прерванная передача продолжается, а не начинается
 * заново.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');
const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));

/** Вызов `scp` командой, а не упоминание слова в комментарии. */
const SCP_CALL = /(?:^|[|;&]\s*|\s)scp\s+[-\w~"'$]/;
const isComment = (line: string): boolean => /^\s*#/.test(line);

describe('файлы на сервер едут rsync, а не scp', () => {
  it('файлы workflow вообще нашлись', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    const source = readFileSync(path.join(WORKFLOWS, file), 'utf8');

    it(`${file}: ни одного scp`, () => {
      const calls = source
        .split('\n')
        .map((line, i) => ({ line, number: i + 1 }))
        .filter(({ line }) => !isComment(line) && SCP_CALL.test(line))
        .map(({ line, number }) => `${number}: ${line.trim()}`);
      expect(
        calls,
        `scp ходит через подсистему SFTP, которой на сервере нет — передача встанет молча. ` +
          `Замените на rsync -e "ssh -i ~/.ssh/deploy_key" (образец — deploy-zapiski.yml)`,
      ).toEqual([]);
    });
  }

  it('образец рядом: деплой веба ходит rsync и не падает', () => {
    /* Если однажды и он переедет на scp — набор обязан упасть здесь, а не
       через месяц на выкладке. */
    const web = readFileSync(path.join(WORKFLOWS, 'deploy-zapiski.yml'), 'utf8');
    expect(web).toMatch(/rsync -az? .*-e "ssh/s);
  });
});
