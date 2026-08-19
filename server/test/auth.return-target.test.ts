/**
 * Куда сервер возвращает человека после входа.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * «При нажатии на войти с Яндекс меня переадресует на сайт zapiski.cmpas.ru и
 * не возвращается в приложение обратно. Redirect URI должен возвращать в ту
 * сущность, откуда был запрос».
 *
 * Так и было: Android получал https-адрес в расчёте на App Links, а проверку
 * владения доменом (`assetlinks.json` с отпечатком ключа подписи) никто не
 * выкладывал. Chrome в этом случае честно открывает сайт — и человек остаётся
 * в браузере с сессией, которая нужна приложению.
 *
 * Решение обязано быть про платформу, а не про домен: приложение возвращают по
 * его собственной схеме, как и предписывает RFC 8252 для родных приложений.
 *
 * ── Почему это проверяется без базы ─────────────────────────────────────────
 *
 * Наборы, которым нужен Postgres, помечены `skipIf(noDatabase())` и там, где
 * базы нет, молча пропускаются. Решение о возврате — как раз то место, где
 * пропуск обошёлся дорого: ошибка видна не в тесте, а на телефоне заказчика.
 * Поэтому сама развилка вынесена в чистую функцию и стережётся здесь.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { authReturnUrl, isAppScheme, magicLinkUrl } from '../src/routes/auth.ts';

const HTTPS = 'https://zapiski.cmpas.ru/auth/callback';
const APP = 'zapiski://auth/callback';
const ENV = { AUTH_SUCCESS_REDIRECT: HTTPS, AUTH_SUCCESS_REDIRECT_APP: APP };

describe('возврат после входа выбирается по платформе', () => {
  it('Android возвращается в приложение, а не на сайт', () => {
    expect(
      authReturnUrl(ENV, 'android'),
      'Android снова уводит человека на сайт — ровно то, на что жаловался заказчик',
    ).toBe(APP);
  });

  it('Windows — тоже своей схемой', () => {
    expect(authReturnUrl(ENV, 'windows')).toBe(APP);
  });

  it('веб остаётся на https: там браузер и есть приложение', () => {
    expect(authReturnUrl(ENV, 'web')).toBe(HTTPS);
  });

  it('платформа неизвестна — https, то есть безопасное умолчание', () => {
    expect(authReturnUrl(ENV, null)).toBe(HTTPS);
    expect(authReturnUrl(ENV, 'symbian')).toBe(HTTPS);
  });

  it('адреса приложения нет — возвращаемся на https, а не в никуда', () => {
    /* Пустая настройка не должна превращаться в редирект на пустую строку:
       это был бы обрыв входа вместо запасного пути. */
    expect(authReturnUrl({ AUTH_SUCCESS_REDIRECT: HTTPS }, 'android')).toBe(HTTPS);
    expect(authReturnUrl({ AUTH_SUCCESS_REDIRECT: HTTPS, AUTH_SUCCESS_REDIRECT_APP: '' }, 'android')).toBe(
      HTTPS,
    );
  });

  it('прежнее имя настройки продолжает работать', () => {
    /* Сервер уже развёрнут с `AUTH_SUCCESS_REDIRECT_DESKTOP`. Выкладка кода
       опережает выкладку окружения ровно настолько, чтобы это стало заметно. */
    expect(
      authReturnUrl({ AUTH_SUCCESS_REDIRECT: HTTPS, AUTH_SUCCESS_REDIRECT_DESKTOP: APP }, 'android'),
    ).toBe(APP);
  });
});

describe('окружение выкладки', () => {
  it('в docker-compose приложениям задана своя схема', () => {
    /* Правка в коде без правки окружения не чинит ничего: адрес возврата
       живёт в compose-файле, и именно он уезжает на сервер. */
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const compose = readFileSync(path.join(root, 'deploy/docker-compose.yml'), 'utf8');
    const line = compose
      .split('\n')
      .find((row) => /^\s*AUTH_SUCCESS_REDIRECT_(APP|DESKTOP):/.test(row));
    expect(line, 'адрес возврата для приложений не задан вовсе').toBeDefined();
    expect(line, 'приложениям задан https — Android снова уедет в браузер').toContain('zapiski://');
  });
});

describe('ссылка из письма', () => {
  const BASE = 'https://zapiski.cmpas.ru';

  it('несёт device_id на любой платформе', () => {
    /* Заказчик: «после перехода из письма по кнопке попадаешь на сайт, а не в
       приложение» — и на Windows, и на Android, при запросе из установленных
       приложений.

       Обмен требует device_id. Взять его неоткуда, кроме самой ссылки: письмо
       открывает браузер, а `x-device-id` ставит своим запросом приложение.
       Прежняя редакция клала device_id только для Windows — на Android и вебе
       ссылка была неразменной в принципе. */
    const url = new URL(magicLinkUrl(BASE, 'tok', 'dev-1234567890'));
    expect(url.searchParams.get('token')).toBe('tok');
    expect(url.searchParams.get('device_id')).toBe('dev-1234567890');
  });

  it('ведёт в ручку API, а не в SPA', () => {
    /* Адрес завязан на `intent-filter` Android: фильтр объявляет ровно этот
       путь, и разъехаться им нельзя. */
    expect(new URL(magicLinkUrl(BASE, 't', 'dev-12345678')).pathname).toBe(
      '/api/v1/auth/magic-link/callback',
    );
  });

  it('не удваивает косую черту, если база с ней', () => {
    expect(magicLinkUrl(`${BASE}/`, 't', 'dev-12345678')).toContain(`${BASE}/api/v1/`);
  });
});

describe('адрес возврата: браузер или приложение', () => {
  it('своя схема опознаётся как приложение', () => {
    expect(isAppScheme('zapiski://auth/callback')).toBe(true);
  });

  it('https и http остаются браузером', () => {
    expect(isAppScheme('https://zapiski.cmpas.ru/auth/callback')).toBe(false);
    expect(isAppScheme('http://localhost:5173/auth/callback')).toBe(false);
    /* Регистр схемы значения не имеет: браузер её нормализует. */
    expect(isAppScheme('HTTPS://zapiski.cmpas.ru/auth/callback')).toBe(false);
  });

  it('путь без схемы приложением не считается', () => {
    expect(isAppScheme('/auth/callback')).toBe(false);
    expect(isAppScheme('')).toBe(false);
  });
});
