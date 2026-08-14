/**
 * Окна приложений обязаны иметь право обратиться к API.
 *
 * ── Дефект, ради которого написан файл ──────────────────────────────────────
 *
 * Заказчик на Android: «вход через Яндекс вроде как произошёл, но папки и
 * записки не появляются, а при нажатии на синхронизацию ничего не происходит».
 *
 * Причина не в синхронизации и не во входе. Окно Tauri живёт на СВОЁМ origin
 * (`http://tauri.localhost` на Windows и Android, `tauri://localhost` на macOS
 * и iOS), а в `CORS_ORIGINS` стоял один адрес сайта. Движок браузера отбивал
 * каждый запрос из приложения ещё ДО сервера — в журналах API их нет вовсе.
 *
 * Вход при этом выглядел удавшимся: токен приезжает диплинком, минуя сеть, а
 * `/auth/me` падает молча (почта в интерфейсе не обязательна). Дальше человек
 * видит «Не удалось синхронизировать · 0 заметок» и не имеет ни одного способа
 * узнать, почему.
 *
 * Проверка смотрит на файл выкладки: правка в коде тут ничего не решает —
 * список origin'ов живёт в окружении, и именно оно уезжает на сервер.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const compose = readFileSync(path.join(root, 'deploy/docker-compose.yml'), 'utf8');
const line = compose.split('\n').find((row) => /^\s*CORS_ORIGINS:/.test(row)) ?? '';

describe('CORS: кто допущен к API', () => {
  it('сайт остаётся в списке', () => {
    expect(line).toContain('https://zapiski.cmpas.ru');
  });

  it('окна Windows и Android допущены', () => {
    expect(
      line,
      'приложения снова будут получать «не удалось синхронизировать» на ровном месте',
    ).toContain('http://tauri.localhost');
  });

  it('окна macOS и iOS допущены', () => {
    /* Их сборок пока нет, но origin у них другой, и вспоминать об этом на
       третьей платформе — терять день на ту же причину. */
    expect(line).toContain('tauri://localhost');
  });

  it('звёздочки в списке нет', () => {
    /* `*` открыл бы API любому сайту. Нужды в этом нет: клиентов у нас
       конечное число, и все они перечислимы. */
    expect(line).not.toContain('*');
  });
});
