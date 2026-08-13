import { escapeHtml } from '../lib/sanitizeHtml.ts';

/**
 * Страница возврата после входа.
 *
 * ── Зачем она есть ──────────────────────────────────────────────────────────
 *
 * Три ручки входа открывает БРАУЗЕР, а не приложение: `/auth/yandex`,
 * `/auth/yandex/callback` и ссылка из письма `/auth/magic-link/callback`. Всё,
 * что они отвечают, человек видит глазами.
 *
 * До этой страницы они отвечали JSON. То есть на любой неудаче — истёкшая
 * ссылка, ссылка, открытая на другом устройстве, невыданный client_id — на
 * весь экран показывалось `{"error":{"code":"magic_link_expired", …}}`. Со
 * стороны это ровно то, на что жаловался заказчик: «авторизация через email в
 * принципе ничего не делает». Она делала — и говорила об этом на машинном
 * языке.
 *
 * Отдельный случай — успех без настроенного адреса возврата: тогда в браузер
 * уезжали ТОКЕНЫ ДОСТУПА открытым текстом. Их нельзя показывать никогда, и
 * страница ниже на этот случай говорит «вернитесь в приложение», а не печатает
 * то, что нашлось.
 *
 * ── Чего здесь нет ──────────────────────────────────────────────────────────
 *
 * Ни одного обращения наружу: ни шрифтов с CDN, ни счётчиков, ни аналитики.
 * Страница автономна — как и публичная (`publicPage.ts`), и по той же причине:
 * человек на ней не давал согласия ни на что.
 */

export interface AuthPage {
  /** Заголовок — одной строкой, без восклицательных знаков (VOICE). */
  title: string;
  /** Пояснение: что случилось и что делать дальше. */
  body: string;
  /** Куда вернуться. `null` — некуда, и тогда кнопки нет вовсе. */
  action?: { href: string; label: string } | null;
}

/* Токены `paper` и `graphite` из DESIGN_TOKENS.md — те же, что у публичной
   страницы: возврат после входа обязан выглядеть частью продукта. */
const STYLE = `
:root {
  --bg:#FBFAF7; --surface:#F3F1EA; --line:#EAE6DB;
  --text:#38342E; --text-secondary:#8A8375; --accent:#B5503C;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#232120; --surface:#2C2A28; --line:#393630;
    --text:#E9E5DC; --text-secondary:#9B948A; --accent:#C56A55;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.6;
}
.card {
  max-width: 420px;
  margin: 24px;
  padding: 32px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 20px;
}
h1 { font-size: 22px; line-height: 1.25; font-weight: 600; margin: 0 0 12px; }
p { margin: 0 0 20px; color: var(--text-secondary); }
p:last-child { margin-bottom: 0; }
a.action {
  display: inline-block;
  padding: 11px 20px;
  border-radius: 99px;
  background: var(--accent);
  color: #fff;
  text-decoration: none;
  font-weight: 500;
}
a.action:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.mark {
  margin-top: 28px;
  font-size: 12px;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
`;

export function renderAuthPage(page: AuthPage): string {
  const action = page.action;
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.body)}</p>
${action ? `<p><a class="action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : ''}
<p class="mark">Записки</p>
</main>
</body>
</html>`;
}
