import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Почта. ADR-0003 §7: письма уходят через уже работающий на хосте postfix
 * (ALLOWED_SENDER_DOMAINS: cmpas.ru). Новых почтовых сервисов не заводим,
 * SMS не используется нигде (ТЗ §5.5, прямой запрет).
 */

export interface MagicLinkMail {
  to: string;
  url: string;
  ttlMinutes: number;
}

export interface Mailer {
  sendMagicLink(mail: MagicLinkMail): Promise<void>;
  /**
   * Готов ли релей принять письмо — БЕЗ отправки.
   *
   * Заведено по отказу, который иначе не виден снаружи: вход по почте отвечал
   * «письмо отправить не удалось», и это единственное, что знал владелец
   * продукта. Причина каждый раз одна и та же по классу — релея нет или он не
   * пускает, — но проверить это можно было только по логам на сервере.
   *
   * Теперь состояние почты видно в `/api/v1/health` рядом с базой и томом:
   * `mail: fail` означает «чинить релей», а не «чинить приложение».
   */
  verify(): Promise<boolean>;

  /**
   * Почему последняя проверка не прошла; `null` — прошла.
   *
   * Заведено по второму витку той же поломки: `mail: fail` показывал, ЧТО
   * сломано, и молчал о том, ПОЧЕМУ. Причина глоталась в `verify()`, и
   * отличить «релей не отвечает» от «релей отвечает, но обрывает нас на
   * STARTTLS» было нечем — а лечатся эти два случая по-разному.
   *
   * В строке только код и текст ошибки транспорта: адреса получателей
   * `verify()` не знает вовсе, потому что письма не отправляет.
   */
  lastFailure(): string | null;
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
  /**
   * Релей стоит на этой же машине, и его сертификат проверить нечем.
   *
   * Нужно ровно для нашего случая. Релей зовётся `host.docker.internal` —
   * имя, на которое сертификата не существует и выдан быть не может, а сам
   * postfix предъявляет самоподписанный. На порту 25 nodemailer при
   * `secure: false` ВСЁ РАВНО поднимает STARTTLS, если сервер его объявляет,
   * и передаёт сокет в `tls.connect` со строгой проверкой. Она падает — и
   * живой релей считается недоступным. Снаружи это и выглядело как
   * `mail: fail` при работающем postfix.
   *
   * Что включается флагом:
   *   • `tls.rejectUnauthorized: false` — рукопожатие проходит, ТРАФИК
   *     ОСТАЁТСЯ ШИФРОВАННЫМ, не проверяется только личность релея;
   *   • `opportunisticTLS` — если релей вовсе откажет на STARTTLS, разговор
   *     продолжится без шифрования, а не оборвётся.
   *
   * Второе без первого не помогает: `opportunisticTLS` спасает только от
   * ОТКАЗА на команду STARTTLS, а провал рукопожатия он не ловит вовсе
   * (nodemailer, `_actionSTARTTLS`). Именно на этом первая попытка починки
   * и не сработала бы.
   *
   * Умолчание — `false`. Для релея за пределами машины проверка сертификата
   * обязана оставаться строгой: там подменить собеседника есть кому.
   */
  localRelayWithoutCertificate?: boolean | undefined;
}

export class SmtpMailer implements Mailer {
  readonly #transport: Transporter;
  readonly #from: string;
  readonly #where: string;
  #failure: string | null = null;

  constructor(options: SmtpOptions) {
    this.#from = options.from;
    this.#where = `${options.host}:${options.port}`;
    this.#transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      // См. `SmtpOptions.localRelayWithoutCertificate`.
      ...(options.localRelayWithoutCertificate === true
        ? { opportunisticTLS: true, tls: { rejectUnauthorized: false } }
        : {}),
      // Локальный postfix обычно без аутентификации.
      auth:
        options.user && options.password
          ? { user: options.user, pass: options.password }
          : undefined,
      // Не даём одному письму подвесить процесс.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async verify(): Promise<boolean> {
    /* `verify` открывает соединение и здоровается — письма не уходит. */
    return this.#transport.verify().then(
      () => {
        this.#failure = null;
        return true;
      },
      (error: unknown) => {
        this.#failure = `${this.#where} — ${describeMailError(error)}`;
        return false;
      },
    );
  }

  lastFailure(): string | null {
    return this.#failure;
  }

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    if (!isSafeMailAddress(mail.to)) {
      // Адрес не проверяется на входе первый раз здесь: `zod().email()` в
      // маршруте уже отсеял большую часть мусора. Эта проверка — второй,
      // независимый барьер прямо перед сетью (см. `isSafeMailAddress`).
      throw new Error('получатель отклонён проверкой адреса перед отправкой');
    }
    const { subject, text, html } = renderMagicLink(mail);
    await this.#transport.sendMail({
      from: this.#from,
      to: mail.to,
      subject,
      text,
      html,
    });
  }
}

/**
 * SEC-020: `nodemailer`/`addressparser` расходились с `zod().email()` в
 * разборе адреса на нескольких CVE (до 7.0.7) — письмо уходило не в тот
 * домен. На пути magic-link это захват аккаунта, а не абстрактный риск,
 * поэтому адрес проверяется ЕЩЁ РАЗ прямо перед `sendMail`, не полагаясь на
 * то, что уже сделал зависимый парсер выше по цепочке. Это не замена
 * `zod().email()`, а второй, независимый барьер: не полный RFC 5322, а
 * минимальный набор запретов ровно под то, чем реально расходились разборы
 * адреса в перечисленных уязвимостях — список получателей через `,`/`;`,
 * второй адрес через `@`, управляющие символы (CR/LF — инъекция заголовков
 * SMTP) и чрезмерная длина.
 */
export function isSafeMailAddress(address: string): boolean {
  if (address.length === 0 || address.length > 254) return false;
  if (/[\r\n]/.test(address)) return false;
  if (/[,;<>]/.test(address)) return false;
  return address.split('@').length === 2;
}

/** Мейлер для тестов и локальной разработки: письма копятся в памяти. */
export class MemoryMailer implements Mailer {
  readonly sent: MagicLinkMail[] = [];

  async verify(): Promise<boolean> {
    return true;
  }

  lastFailure(): string | null {
    return null;
  }

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
    this.sent.push(mail);
  }

  last(): MagicLinkMail | undefined {
    return this.sent.at(-1);
  }

  reset(): void {
    this.sent.length = 0;
  }
}

/**
 * Текст письма. Тон — как на экране входа (SCREENS §2): без восклицательных
 * знаков, без «подтвердите регистрацию», прямо о том, что произойдёт.
 */
export function renderMagicLink(mail: MagicLinkMail): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = 'Ссылка для входа в ЗАПИСКИ';
  const text = [
    'Вы запросили вход в ЗАПИСКИ.',
    '',
    mail.url,
    '',
    `Ссылка действует ${mail.ttlMinutes} минут и открывается один раз — на том устройстве, где вы её запросили.`,
    'Если вход запрашивали не вы, просто закройте это письмо: ничего не произойдёт.',
    '',
    'Заметку, зашифрованную вами в приложении, мы прочитать не можем технически — остальные заметки хранятся как обычный текст, пока облачная синхронизация не зашифрует их сама (SEC-001).',
  ].join('\n');

  const html = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>',
    '<body style="margin:0;padding:32px;background:#faf9f7;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b1a">',
    '<div style="max-width:520px;margin:0 auto">',
    '<p style="margin:0 0 24px">Вы запросили вход в ЗАПИСКИ.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(mail.url)}" style="display:inline-block;padding:12px 22px;border-radius:14px;background:#1c1b1a;color:#faf9f7;text-decoration:none">Войти в ЗАПИСКИ</a></p>`,
    `<p style="margin:0 0 12px;color:#6b6864;font-size:14px">Ссылка действует ${mail.ttlMinutes} минут и открывается один раз — на том устройстве, где вы её запросили.</p>`,
    '<p style="margin:0 0 24px;color:#6b6864;font-size:14px">Если вход запрашивали не вы, просто закройте это письмо: ничего не произойдёт.</p>',
    '<p style="margin:0;color:#6b6864;font-size:13px">Заметку, зашифрованную вами в приложении, мы прочитать не можем технически — остальные заметки хранятся как обычный текст, пока облачная синхронизация не зашифрует их сама (SEC-001).</p>',
    '</div></body></html>',
  ].join('');

  return { subject, text, html };
}

/**
 * Отказ транспорта — одной строкой для журнала.
 *
 * Берётся код (`ESOCKET`, `ECONNECTION`, `EAUTH`, `ERR_TLS_CERT_ALTNAME_INVALID`
 * и подобные) и текст: по ним видно, на каком шаге разговор оборвался.
 *
 * Адреса вычищаются. У `verify()` получателя нет вовсе, но эта же строка
 * пишется при отказе НАСТОЯЩЕЙ отправки, а там релей охотно возвращает
 * `550 5.1.1 <кто-то@example.com> User unknown` — то есть почту живого
 * человека. По ТЗ §6 адрес в журнал не попадает: по нему пользователь
 * опознаётся однозначно.
 */
export function describeMailError(error: unknown): string {
  if (error === null || error === undefined) return 'причина неизвестна';

  const record = error as { code?: unknown; command?: unknown; message?: unknown };
  const parts: string[] = [];
  if (typeof record.code === 'string' && record.code !== '') parts.push(record.code);
  if (typeof record.command === 'string' && record.command !== '') {
    parts.push(`на команде ${record.command}`);
  }

  const message =
    typeof record.message === 'string' && record.message !== '' ? record.message : String(error);
  parts.push(message);

  /* Длинный стек в журнал не тащим: он не помогает и мешает читать. */
  return redactAddresses(parts.join(' · ')).slice(0, 400);
}

/** Любой адрес почты в тексте отказа заменяется меткой. */
function redactAddresses(value: string): string {
  return value.replace(/[^\s<>()[\]:;,"]+@[^\s<>()[\]:;,"]+\.[a-z]{2,}/gi, '[адрес скрыт]');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
