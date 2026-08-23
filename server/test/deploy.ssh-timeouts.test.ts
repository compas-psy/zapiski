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

/**
 * Вызов ssh/scp ГДЕ УГОДНО в строке, а не только в её начале.
 *
 * Сначала здесь стоял якорь `^\s*`, и это была дыра ровно под ту правку,
 * которую он должен стеречь: команда, переехавшая в конвейер
 * (`dd … | ssh …`) или за `&&`, переставала опознаваться — и сторож молча
 * переставал на неё смотреть. Сторож, зеленеющий от исчезновения предмета,
 * не отличим от сторожа, зеленеющего от починки.
 *
 * Строка-комментарий исключается: в этом файле их больше, чем команд, и
 * почти каждая упоминает ssh.
 */
const SSH_CALL = /(?:^|[|;&]\s*|\s)(?:ssh|scp|ssh-keyscan)\s+[-\w~"'$]/;

/** Потолок в любом месте строки — перед командой он или в начале конвейера. */
const CAPPED = /\btimeout\s+(?:-\S+\s+)*\d+\s/;

const isComment = (line: string): boolean => /^\s*#/.test(line);

const sshCalls = (body: string): string[] =>
  body.split('\n').filter((line) => !isComment(line) && SSH_CALL.test(line));

const usesSsh = (body: string): boolean => sshCalls(body).length > 0;

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

    /* ── Урок прогона 188 ─────────────────────────────────────────────────
     *
     * Потолок у ШАГА молчание заканчивает, но не объясняет. Прогон 188:
     * пять минут ни одной строки, затем «has timed out after 5 minutes» — и
     * разбирать нечего. Шаг звал четыре команды подряд (getaddrinfo внутри
     * ssh, keyscan, mkdir, scp), в логе не было ни одной из них, а
     * `ConnectTimeout`/`ServerAlive*` разрешение имени не покрывают вовсе.
     *
     * Поэтому потолок нужен КАЖДОЙ команде: тогда падает она, а не шаг, и
     * падает раньше потолка шага — то есть успевает быть названной. */
    it(`${label}: у каждой команды ssh свой потолок, а не только у шага`, () => {
      const naked = ssh.flatMap((step) =>
        sshCalls(step.body)
          .filter((line) => !CAPPED.test(line))
          .map((line) => `${step.name}: ${line.trim()}`),
      );
      expect(naked, `команды ssh без своего timeout в ${file}`).toEqual([]);
    });

    it(`${label}: шаг называет, на чём встал`, () => {
      /* Потолок команды даёт код 124 и ни слова о том, ЧТО не уложилось.
         Ловушка ERR печатает имя фазы — иначе разбор снова упрётся в
         пустой лог. */
      const mute = ssh.filter((step) => !/trap\s+'[^']*'\s+ERR/.test(step.body)).map((s) => s.name);
      expect(mute, `шаги без ловушки ERR в ${file}`).toEqual([]);
    });
  }

  it('build-android.yml по-прежнему под присмотром', () => {
    /* Явный счёт — на случай, если шаги переименуют или разбор изменится:
       набор обязан упасть, а не потерять предмет молча. */
    const source = readFileSync(path.join(WORKFLOWS, 'build-android.yml'), 'utf8');
    const ssh = stepsOf(source).filter((step) => usesSsh(step.body));
    expect(ssh.map((s) => s.name)).toHaveLength(4);
  });
});
