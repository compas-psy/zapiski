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
}

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

export class SmtpMailer implements Mailer {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(options: SmtpOptions) {
    this.#from = options.from;
    this.#transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
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

  async sendMagicLink(mail: MagicLinkMail): Promise<void> {
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

/** Мейлер для тестов и локальной разработки: письма копятся в памяти. */
export class MemoryMailer implements Mailer {
  readonly sent: MagicLinkMail[] = [];

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
    'Заметки мы не читаем — технически не можем.',
  ].join('\n');

  const html = [
    '<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>',
    '<body style="margin:0;padding:32px;background:#faf9f7;font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b1a">',
    '<div style="max-width:520px;margin:0 auto">',
    '<p style="margin:0 0 24px">Вы запросили вход в ЗАПИСКИ.</p>',
    `<p style="margin:0 0 24px"><a href="${escapeHtml(mail.url)}" style="display:inline-block;padding:12px 22px;border-radius:14px;background:#1c1b1a;color:#faf9f7;text-decoration:none">Войти в ЗАПИСКИ</a></p>`,
    `<p style="margin:0 0 12px;color:#6b6864;font-size:14px">Ссылка действует ${mail.ttlMinutes} минут и открывается один раз — на том устройстве, где вы её запросили.</p>`,
    '<p style="margin:0 0 24px;color:#6b6864;font-size:14px">Если вход запрашивали не вы, просто закройте это письмо: ничего не произойдёт.</p>',
    '<p style="margin:0;color:#6b6864;font-size:13px">Заметки мы не читаем — технически не можем.</p>',
    '</div></body></html>',
  ].join('');

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
