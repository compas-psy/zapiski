/**
 * Санитайзер HTML для публикации по ссылке (ТЗ §5.3).
 *
 * Сервер не имеет ключей и не может отрендерить markdown из шифротекста,
 * поэтому HTML присылает клиент. Присланное — недоверенный ввод: любой,
 * у кого есть токен, может отправить сюда что угодно, а страница отдаётся с
 * нашего домена.
 *
 * Защита двухслойная и слои независимы:
 *
 *  1. Этот белый список: разрешены только теги и атрибуты, которые может дать
 *     markdown. Всё остальное отбрасывается; содержимое `script`, `style`,
 *     `iframe`, `object`, `svg` выкидывается вместе с тегом.
 *  2. Заголовок CSP на `/p/:slug` вообще не содержит `script-src`, поэтому при
 *     `default-src 'none'` скрипт не выполнится, даже если просочится сюда.
 *
 * Санитайзер намеренно консервативен: неизвестный тег теряется, а не
 * «пропускается на всякий случай».
 */

/** Теги, которые может породить markdown-рендер. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'del', 's', 'mark', 'sub', 'sup', 'small',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code', 'kbd', 'samp',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'dl', 'dt', 'dd',
  'section', 'article', 'div', 'span',
]);

/** Теги, чьё содержимое выбрасывается целиком, а не разворачивается в текст. */
const VOID_CONTENT_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math',
  'template', 'noscript', 'form', 'input', 'button', 'select', 'textarea',
  'link', 'meta', 'base', 'title', 'head', 'audio', 'video', 'canvas',
]);

/** Теги без закрывающего. */
const SELF_CLOSING = new Set(['br', 'hr', 'img']);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align', 'scope']),
  ol: new Set(['start', 'reversed']),
  li: new Set(['value']),
  code: new Set(['class']),
  pre: new Set(['class']),
  span: new Set(['class']),
  div: new Set(['class']),
  section: new Set(['class']),
  blockquote: new Set(['cite']),
};

/** Значения `class`, которые пропускаются: подсветка кода и сноски. */
const CLASS_RE = /^[A-Za-z0-9 _-]{0,200}$/;

const SAFE_URL_RE = /^(https?:\/\/|mailto:|#|\/)/i;
const SAFE_IMG_SRC_RE = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|avif);base64,)/i;

export interface SanitizeResult {
  html: string;
  /** Сколько узлов отброшено — полезно в тесте и в логе публикации. */
  dropped: number;
}

export function sanitizeHtml(input: string): SanitizeResult {
  let dropped = 0;
  const out: string[] = [];
  const open: string[] = [];

  // Пропуск содержимого запрещённого тега: считаем вложенность.
  let skipTag: string | null = null;
  let skipDepth = 0;

  const tokenizer = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?/]?[A-Za-z][^>]*>|<[!?][^>]*>/g;
  let cursor = 0;

  for (let match = tokenizer.exec(input); match !== null; match = tokenizer.exec(input)) {
    const text = input.slice(cursor, match.index);
    if (skipTag === null && text.length > 0) out.push(escapeStrayAngles(text));
    cursor = match.index + match[0].length;

    const token = match[0];

    // Комментарии, CDATA, doctype, processing instructions — прочь.
    if (token.startsWith('<!') || token.startsWith('<?')) {
      dropped += 1;
      continue;
    }

    const closing = token.startsWith('</');
    const nameMatch = /^<\/?\s*([A-Za-z][A-Za-z0-9]*)/.exec(token);
    const name = nameMatch?.[1]?.toLowerCase();
    if (name === undefined) {
      dropped += 1;
      continue;
    }

    if (skipTag !== null) {
      if (name === skipTag) {
        if (closing) {
          skipDepth -= 1;
          if (skipDepth === 0) skipTag = null;
        } else if (!token.endsWith('/>')) {
          skipDepth += 1;
        }
      }
      continue;
    }

    if (VOID_CONTENT_TAGS.has(name)) {
      dropped += 1;
      if (!closing && !token.endsWith('/>')) {
        skipTag = name;
        skipDepth = 1;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Неизвестный тег: сам тег теряется, текст внутри остаётся.
      dropped += 1;
      continue;
    }

    if (closing) {
      const index = open.lastIndexOf(name);
      if (index === -1) {
        dropped += 1;
        continue;
      }
      // Закрываем всё, что осталось открытым внутри, — иначе вложенность
      // «поедет» и разметка страницы поплывёт.
      while (open.length > index) {
        const tag = open.pop();
        if (tag !== undefined) out.push(`</${tag}>`);
      }
      continue;
    }

    const attrs = sanitizeAttributes(name, token);
    if (attrs.dropped > 0) dropped += attrs.dropped;

    if (SELF_CLOSING.has(name)) {
      out.push(`<${name}${attrs.text}>`);
      continue;
    }
    out.push(`<${name}${attrs.text}>`);
    open.push(name);
  }

  const tail = input.slice(cursor);
  if (skipTag === null && tail.length > 0) out.push(escapeStrayAngles(tail));

  while (open.length > 0) {
    const tag = open.pop();
    if (tag !== undefined) out.push(`</${tag}>`);
  }

  return { html: out.join(''), dropped };
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;

function sanitizeAttributes(tag: string, token: string): { text: string; dropped: number } {
  const allowed = ALLOWED_ATTRS[tag];
  if (allowed === undefined) return { text: '', dropped: 0 };

  // Отрезаем `<tag` и `>` — дальше разбираем только пары атрибутов.
  const body = token.replace(/^<\s*[A-Za-z][A-Za-z0-9]*/, '').replace(/\/?>$/, '');

  const parts: string[] = [];
  let dropped = 0;

  for (let match = ATTR_RE.exec(body); match !== null; match = ATTR_RE.exec(body)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[3] ?? match[4] ?? match[5] ?? '';

    // Обработчики событий отбрасываются даже если бы попали в белый список.
    if (name.startsWith('on') || !allowed.has(name)) {
      dropped += 1;
      continue;
    }

    if (name === 'href' || name === 'cite') {
      if (!isSafeUrl(value)) {
        dropped += 1;
        continue;
      }
    }
    if (name === 'src' && !SAFE_IMG_SRC_RE.test(value.trim())) {
      dropped += 1;
      continue;
    }
    if (name === 'class' && !CLASS_RE.test(value)) {
      dropped += 1;
      continue;
    }
    if ((name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan' || name === 'start' || name === 'value') && !/^\d{1,5}$/.test(value.trim())) {
      dropped += 1;
      continue;
    }

    parts.push(` ${name}="${escapeAttribute(value)}"`);
  }
  ATTR_RE.lastIndex = 0;

  // Внешние ссылки открываем безопасно: noopener закрывает доступ к window.opener.
  if (tag === 'a' && parts.some((p) => p.startsWith(' href='))) {
    parts.push(' rel="noopener nofollow ugc"');
  }
  if (tag === 'img') {
    parts.push(' loading="lazy"');
  }

  return { text: parts.join(''), dropped };
}

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // `javascript:` с переносами/табами внутри — классический обход.
  const collapsed = trimmed.replace(/[\s\x00-\x1f\x7f]/g, '');
  if (/^[a-z]+:/i.test(collapsed) && !/^(https?|mailto):/i.test(collapsed)) return false;
  return SAFE_URL_RE.test(collapsed);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Одиночные `<` и `>` в тексте экранируем — тегами они уже не станут. */
function escapeStrayAngles(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Экранирование для полей, которые мы вставляем сами (заголовок страницы). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
