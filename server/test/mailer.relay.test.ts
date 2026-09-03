import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import tls from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeMailError, SmtpMailer } from '../src/services/mailer.ts';

/**
 * Почта, второй виток.
 *
 * Заказчик дважды видел одно и то же: «Письмо со ссылкой отправить не удалось»
 * и `mail: fail` в health. Первый раз чинили адрес релея — не помогло, потому
 * что адрес был ни при чём. Настоящая причина лежит там, куда ни одна прежняя
 * проверка не заглядывала: релей ОТВЕЧАЕТ, приветствие 220 приходит, а
 * nodemailer на порту 25 сам поднимает STARTTLS и строго проверяет сертификат.
 * Сертификата на имя `host.docker.internal` не бывает, проверка падает —
 * и живой postfix объявляется недоступным.
 *
 * Поэтому тест поднимает НАСТОЯЩИЙ SMTP-сервер с самоподписанным
 * сертификатом и настоящим рукопожатием TLS. Проверка «замокали транспорт и
 * убедились, что опция передалась» этот дефект пропустила бы: она проверяет
 * наши намерения, а сломалось рукопожатие.
 */

let certDir: string;
let key: string;
let cert: string;

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'zapiski-relay-'));
  /* Самоподписанный — ровно как у postfix'а на хосте. Живёт минуты, лежит во
     временном каталоге и в репозиторий не попадает. */
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(certDir, 'key.pem'),
      '-out', join(certDir, 'cert.pem'),
      '-days', '1',
      '-subj', '/CN=zapiski-test-relay',
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(certDir, 'key.pem'), 'utf8');
  cert = readFileSync(join(certDir, 'cert.pem'), 'utf8');
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

/** Как релей отвечает на STARTTLS. */
type TlsBehaviour = 'upgrade' | 'refuse' | 'absent';

interface FakeRelay {
  port: number;
  close(): Promise<void>;
}

/** Крошечный SMTP-сервер: столько протокола, сколько трогает `verify()`. */
async function startRelay(behaviour: TlsBehaviour): Promise<FakeRelay> {
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 zapiski-test-relay ESMTP\r\n');
    converse(socket);
  });

  function converse(stream: Duplex, secured = false): void {
    let buffer = '';
    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
        index = buffer.indexOf('\r\n');
      }
    };

    const handle = (line: string): void => {
      const verb = line.split(' ')[0]?.toUpperCase() ?? '';

      if (verb === 'EHLO' || verb === 'HELO') {
        const offerTls = behaviour !== 'absent' && !secured;
        stream.write(
          offerTls
            ? '250-zapiski-test-relay\r\n250-STARTTLS\r\n250 OK\r\n'
            : '250-zapiski-test-relay\r\n250 OK\r\n',
        );
        return;
      }

      if (verb === 'STARTTLS') {
        if (behaviour === 'refuse') {
          stream.write('454 4.7.0 TLS not available\r\n');
          return;
        }
        stream.write('220 2.0.0 Ready to start TLS\r\n');
        stream.removeListener('data', onData);
        const secure = new tls.TLSSocket(stream as net.Socket, { isServer: true, key, cert });
        secure.on('error', () => {});
        converse(secure, true);
        return;
      }

      if (verb === 'QUIT') {
        stream.write('221 2.0.0 Bye\r\n');
        stream.end();
        return;
      }

      stream.write('250 OK\r\n');
    };

    stream.on('data', onData);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('релей не поднялся');

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function mailerFor(port: number, localRelay: boolean): SmtpMailer {
  return new SmtpMailer({
    host: '127.0.0.1',
    port,
    secure: false,
    from: 'ЗАПИСКИ <zapiski@cmpas.ru>',
    localRelayWithoutCertificate: localRelay,
  });
}

describe('релей с самоподписанным сертификатом', () => {
  it('строгая проверка объявляет живой релей недоступным', async () => {
    const relay = await startRelay('upgrade');
    try {
      const mailer = mailerFor(relay.port, false);
      expect(await mailer.verify()).toBe(false);
      /* Причина обязана быть названа: без неё `mail: fail` не отличить от
         «релея нет вовсе», а лечатся эти два случая по-разному. */
      expect(mailer.lastFailure()).toMatch(/TLS|certificate|сертификат/i);
      expect(mailer.lastFailure()).toContain(`127.0.0.1:${relay.port}`);
    } finally {
      await relay.close();
    }
  });

  it('локальный релей проходит проверку — письмо уйдёт', async () => {
    const relay = await startRelay('upgrade');
    try {
      const mailer = mailerFor(relay.port, true);
      expect(await mailer.verify()).toBe(true);
      expect(mailer.lastFailure()).toBeNull();
    } finally {
      await relay.close();
    }
  });
});

describe('релей, отказывающий на STARTTLS', () => {
  it('строгая проверка обрывается', async () => {
    const relay = await startRelay('refuse');
    try {
      const mailer = mailerFor(relay.port, false);
      expect(await mailer.verify()).toBe(false);
    } finally {
      await relay.close();
    }
  });

  it('локальный релей продолжает разговор без шифрования', async () => {
    const relay = await startRelay('refuse');
    try {
      const mailer = mailerFor(relay.port, true);
      expect(await mailer.verify()).toBe(true);
    } finally {
      await relay.close();
    }
  });
});

describe('релей вовсе без STARTTLS', () => {
  it('проходит в обоих режимах — флаг ничего не ломает', async () => {
    const relay = await startRelay('absent');
    try {
      expect(await mailerFor(relay.port, false).verify()).toBe(true);
      expect(await mailerFor(relay.port, true).verify()).toBe(true);
    } finally {
      await relay.close();
    }
  });
});

describe('молчащий адрес', () => {
  it('называется отказом с кодом, а не пустой строкой', async () => {
    /* Порт 1 закрыт всегда: ECONNREFUSED приходит сразу, без ожидания. */
    const mailer = mailerFor(1, true);
    expect(await mailer.verify()).toBe(false);
    expect(mailer.lastFailure()).toMatch(/ECONN|ESOCKET|127\.0\.0\.1:1/);
  });
});

describe('SEC-020: адрес получателя проверяется перед отправкой', () => {
  /*
   * `nodemailer` до 7.0.7 расходился с `zod().email()` в разборе адреса —
   * несколько CVE, включая «письмо уходит не в тот домен». На пути
   * magic-link это означает захват аккаунта, поэтому адрес проверяется
   * ЕЩЁ РАЗ прямо перед `sendMail`, не полагаясь на то, что уже сделал
   * чужой парсер выше по цепочке. Релей в этих проверках недостижим
   * (порт 1 закрыт всегда) — если бы проверка не срабатывала ДО сети,
   * отказ пришёл бы с сетевым кодом (ECONNREFUSED), а не с кодом отказа
   * валидации; тесты ниже отличают эти два случая по тексту причины.
   */
  const unreachable = (): SmtpMailer => mailerFor(1, true);

  it.each([
    ['два адреса через запятую', 'a@cmpas.ru,evil@attacker.example'],
    ['второй адрес через точку с запятой', 'a@cmpas.ru;evil@attacker.example'],
    ['два @ подряд', 'a@b@evil.example'],
    ['угловые скобки вокруг адреса', '<a@cmpas.ru>'],
    ['перевод строки — CRLF-инъекция в заголовки', 'a@cmpas.ru\r\nBcc: evil@attacker.example'],
    ['голый перевод строки', 'a@cmpas.ru\nBcc: evil@attacker.example'],
    ['длиннее 254 символов', `${'a'.repeat(250)}@cmpas.ru`],
    ['без @ вовсе', 'не-адрес'],
  ])('%s — отклоняется, релея не касается', async (_name, address) => {
    const mailer = unreachable();
    await expect(
      mailer.sendMagicLink({ to: address, url: 'https://cmpas.ru/x', ttlMinutes: 15 }),
    ).rejects.toThrow(/адрес/i);
  });

  it('обычный адрес по-прежнему уходит в релей — проверка не мешает штатному входу', async () => {
    const relay = await startRelay('upgrade');
    try {
      const mailer = mailerFor(relay.port, true);
      await expect(
        mailer.sendMagicLink({ to: 'user@cmpas.ru', url: 'https://cmpas.ru/x', ttlMinutes: 15 }),
      ).resolves.toBeUndefined();
    } finally {
      await relay.close();
    }
  });
});

describe('describeMailError', () => {
  it('складывает код, команду и текст', () => {
    const error = Object.assign(new Error('Error initiating TLS'), {
      code: 'ETLS',
      command: 'STARTTLS',
    });
    expect(describeMailError(error)).toBe('ETLS · на команде STARTTLS · Error initiating TLS');
  });

  it('не роняет отчёт на пустоте', () => {
    expect(describeMailError(null)).toBe('причина неизвестна');
    expect(describeMailError(undefined)).toBe('причина неизвестна');
  });

  it('вычищает адрес получателя из отказа релея', () => {
    /* ТЗ §6: по адресу пользователь опознаётся однозначно, в журнале его быть
       не должно. Релей же охотно возвращает его в тексте отказа. */
    const error = Object.assign(
      new Error('550 5.1.1 <someone@example.org>: Recipient address rejected'),
      { code: 'EENVELOPE', command: 'RCPT TO' },
    );
    const described = describeMailError(error);
    expect(described).not.toContain('someone@example.org');
    expect(described).toContain('[адрес скрыт]');
    /* Код и команда остаются — по ним и чинят. */
    expect(described).toContain('EENVELOPE');
    expect(described).toContain('RCPT TO');
  });

  it('обрезает длинный текст, чтобы журнал оставался читаемым', () => {
    expect(describeMailError(new Error('я'.repeat(900))).length).toBeLessThanOrEqual(400);
  });
});
