/**
 * Шаг, ходящий по ssh, обязан падать громко, а не висеть молча.
 *
 * ── Что случилось ───────────────────────────────────────────────────────────
 *
 * Прогон 162 «Сборка Android»: APK собран, подписан, проверен и приложен к
 * прогону — а следующий шаг, выкладка на сервер, простоял больше получаса и
 * стоял бы до потолка job. Заказчик всё это время видел «идёт сборка».
 *
 * Причина у молчания одна и та же в любом ssh: без `BatchMode` клиент, не
 * приняв ключ, спрашивает пароль и ждёт ответа, которого на раннере не будет
 * никогда; без `ConnectTimeout` он ждёт установки связи; без `ServerAlive*` —
 * ответа по уже установленной. Ни один из этих случаев ничего не печатает.
 *
 * Обиднее всего, что упасть было безопасно: следующий шаг разбирает неудачную
 * доставку сам — на ветке, чьи сборки предлагает промостраница, валит прогон,
 * на прочих печатает предупреждение. Работал весь механизм, кроме умения
 * закончиться.
 *
 * ── Что стережётся ──────────────────────────────────────────────────────────
 *
 * Правило: если шаг зовёт `ssh` или `scp`, у него есть потолок времени, а у
 * job — настройки, отменяющие интерактивные вопросы.
 *
 * `НЕ ПРИВЕДЁННЫЕ В ПОРЯДОК` — список файлов с тем же дефектом, до которых
 * ещё не дошли руки. Он существует затем, чтобы упущение было названо, а не
 * забыто: сокращать его можно, пополнять — нет.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows');

/**
 * Сюда правку ещё не донесли.
 *
 * `build-windows.yml` не трогается по прямому запрету заказчика: любая правка,
 * ломающая сборку Windows, — брак, и трогать её отдельно от разговора нельзя.
 * Два деплойных workflow ждут той же отмашки.
 */
const NOT_YET = new Set(['build-windows.yml', 'deploy-zapiski.yml', 'provision-zapiski.yml']);

interface Step {
  name: string;
  body: string;
}

/**
 * Разбор без библиотеки YAML: её в зависимостях нет, а тащить парсер ради
 * одной проверки дороже, чем разрезать по границе шага. Граница однозначна —
 * `- name:` с отступом ровно в шесть пробелов.
 */
function stepsOf(source: string): Step[] {
  const lines = source.split('\n');
  const steps: Step[] = [];
  let current: Step | null = null;
  for (const line of lines) {
    const start = /^ {6}- name: (.+)$/.exec(line);
    if (start !== null) {
      if (current !== null) steps.push(current);
      current = { name: start[1] ?? '', body: '' };
      continue;
    }
    /* Новый job — предыдущий шаг закончился. */
    if (/^ {2}\S/.test(line) && current !== null) {
      steps.push(current);
      current = null;
      continue;
    }
    if (current !== null) current.body += `${line}\n`;
  }
  if (current !== null) steps.push(current);
  return steps;
}

const usesSsh = (body: string): boolean => /^\s*(ssh|scp|ssh-keyscan)\s/m.test(body);

const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));

describe('выкладка по ssh не может висеть молча', () => {
  it('файлы workflow вообще нашлись', () => {
    /* Без этого набор был бы зелёным на пустом каталоге — то есть врал бы. */
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    const source = readFileSync(path.join(WORKFLOWS, file), 'utf8');
    const ssh = stepsOf(source).filter((step) => usesSsh(step.body));
    if (ssh.length === 0) continue;

    const pending = NOT_YET.has(file);
    const label = pending ? `${file} — известен и НЕ приведён в порядок` : file;

    it(`${label}: у каждого ssh-шага есть потолок времени`, () => {
      const naked = ssh.filter((step) => !/^\s*timeout-minutes:/m.test(step.body)).map((s) => s.name);
      if (pending) {
        /* Утверждение перевёрнуто намеренно. Пока файл в списке, дефект в нём
           ОЖИДАЕТСЯ: как только его починят, набор упадёт и потребует вычеркнуть
           файл из списка. Забыть вычеркнуть — не получится. */
        expect(naked.length, `${file} уже починен — вычеркните его из NOT_YET`).toBeGreaterThan(0);
        return;
      }
      expect(naked, `шаги без timeout-minutes в ${file}`).toEqual([]);
    });

    if (pending) continue;

    it(`${label}: интерактивных вопросов ssh не задаёт`, () => {
      /* BatchMode — единственное, что отличает «упало за секунду» от
         «висит до потолка job». */
      expect(source, `в ${file} нет BatchMode`).toContain('BatchMode yes');
      expect(source, `в ${file} нет ConnectTimeout`).toContain('ConnectTimeout');
      /* Связь рвётся и после установки: прогон 162 до сервера дошёл. */
      expect(source, `в ${file} нет ServerAliveInterval`).toContain('ServerAliveInterval');
      /* У ssh-keyscan свой таймаут, и без него первым висел бы он. */
      expect(source, `в ${file} у ssh-keyscan нет -T`).toMatch(/ssh-keyscan -T \d+/);
    });
  }
});
