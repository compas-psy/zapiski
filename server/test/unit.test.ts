import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { normalizeEtag, safeEqual, randomSlug } from '../src/lib/crypto.ts';
import { signJwt, verifyJwt } from '../src/lib/jwt.ts';
import { escapeHtml, sanitizeHtml } from '../src/lib/sanitizeHtml.ts';
import { amountRub, periodEnd } from '../src/services/subscription.ts';
import { compareVersions, selectPlatforms } from '../src/routes/updates.ts';
import { renderPublicPage } from '../src/views/publicPage.ts';

const SECRET = 'unit-test-secret-длиной-больше-32-символов';

describe('JWT HS256', () => {
  it('подписывает и проверяет', () => {
    const token = signJwt({ sub: 'u1', sid: 's1', did: 'd1', typ: 'access' }, SECRET, 60);
    const result = verifyJwt(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe('u1');
  });

  it('отвергает чужую подпись', () => {
    const token = signJwt({ sub: 'u1', sid: 's1', did: 'd1', typ: 'access' }, SECRET, 60);
    const result = verifyJwt(token, `${SECRET}-другой`);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('отвергает alg: none — классическая дыра реализаций JWT', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'admin', sid: 's', did: 'd', typ: 'access', iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    expect(verifyJwt(`${header}.${payload}.`, SECRET)).toEqual({
      ok: false,
      reason: 'bad_algorithm',
    });
  });

  it('отвергает подмену алгоритма на HS512 при верном HMAC', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'admin', sid: 's', did: 'd', typ: 'access', iat: 1, exp: 9_999_999_999 }),
    ).toString('base64url');
    const signature = createHmac('sha512', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(verifyJwt(`${header}.${payload}.${signature}`, SECRET).ok).toBe(false);
  });

  it('уважает срок жизни', () => {
    const token = signJwt({ sub: 'u1', sid: 's1', did: 'd1', typ: 'access' }, SECRET, 10);
    expect(verifyJwt(token, SECRET, Date.now() + 11_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('битый токен не роняет разбор', () => {
    for (const bad of ['', 'a.b', 'a.b.c', 'ыыы.ыыы.ыыы']) {
      expect(verifyJwt(bad, SECRET).ok).toBe(false);
    }
  });
});

describe('вспомогательное крипто', () => {
  it('safeEqual', () => {
    expect(safeEqual('одинаково', 'одинаково')).toBe(true);
    expect(safeEqual('одинаково', 'по-разному')).toBe(false);
    expect(safeEqual('короткое', 'длинное значение')).toBe(false);
  });

  it('normalizeEtag снимает W/ и добавляет кавычки', () => {
    expect(normalizeEtag('W/"abc"')).toBe('"abc"');
    expect(normalizeEtag('abc')).toBe('"abc"');
    expect(normalizeEtag(' "abc" ')).toBe('"abc"');
  });

  it('slug из безопасного алфавита без похожих символов', () => {
    for (let i = 0; i < 50; i += 1) {
      const slug = randomSlug();
      expect(slug).toMatch(/^[a-z2-9]{12}$/);
      expect(slug).not.toMatch(/[lo01]/);
    }
  });
});

describe('санитайзер HTML для публичной страницы', () => {
  it('вырезает script вместе с содержимым', () => {
    const { html } = sanitizeHtml('<p>до</p><script>alert(1)</script><p>после</p>');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('script');
    expect(html).toContain('<p>до</p>');
    expect(html).toContain('<p>после</p>');
  });

  it('снимает обработчики событий', () => {
    const { html } = sanitizeHtml('<p onclick="steal()">текст</p><img src="https://a/b.png" onerror="x()">');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).toContain('текст');
  });

  it('отбрасывает javascript: и data: в href', () => {
    for (const bad of [
      '<a href="javascript:alert(1)">клик</a>',
      '<a href="java\tscript:alert(1)">клик</a>',
      '<a href="JaVaScRiPt:alert(1)">клик</a>',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">клик</a>',
      '<a href="vbscript:msgbox">клик</a>',
    ]) {
      const { html } = sanitizeHtml(bad);
      expect(html, bad).not.toContain('href=');
      expect(html, bad).toContain('клик');
    }
  });

  it('пропускает нормальные ссылки и добавляет rel', () => {
    const { html } = sanitizeHtml('<a href="https://example.org/статья">ссылка</a>');
    expect(html).toContain('href="https://example.org/статья"');
    expect(html).toContain('rel="noopener nofollow ugc"');
  });

  it('вырезает iframe, object, svg и формы', () => {
    const { html } = sanitizeHtml(
      '<iframe src="https://evil"></iframe><object data="x"></object><svg onload="x"></svg><form action="/"><input name="a"></form>',
    );
    expect(html.replace(/\s/g, '')).toBe('');
  });

  it('оставляет разметку markdown', () => {
    const source =
      '<h1>Заголовок</h1><p><strong>жирный</strong> и <em>курсив</em></p><ul><li>раз</li><li>два</li></ul><blockquote><p>цитата</p></blockquote><pre><code class="language-ts">const a = 1;</code></pre><table><tr><td colspan="2">ячейка</td></tr></table>';
    const { html } = sanitizeHtml(source);
    for (const fragment of ['<h1>', '<strong>', '<em>', '<ul>', '<li>', '<blockquote>', '<pre>', '<code class="language-ts">', '<table>', 'colspan="2"']) {
      expect(html, fragment).toContain(fragment);
    }
  });

  it('картинки только по http(s) и data:image', () => {
    const ok = sanitizeHtml('<img src="https://example.org/a.png" alt="кот">');
    expect(ok.html).toContain('src="https://example.org/a.png"');
    expect(ok.html).toContain('loading="lazy"');

    const bad = sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    expect(bad.html).not.toContain('src=');
  });

  it('закрывает незакрытые теги, а не ломает страницу', () => {
    const { html } = sanitizeHtml('<p>текст<strong>жирный');
    expect(html).toBe('<p>текст<strong>жирный</strong></p>');
  });

  it('экранирует одиночные угловые скобки в тексте', () => {
    const { html } = sanitizeHtml('<p>1 < 2 и 3 > 2</p>');
    expect(html).not.toMatch(/[^&]<(?!\/?p>)/);
    expect(html).toContain('&lt;');
  });

  it('escapeHtml экранирует кавычки и скобки', () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});

describe('публичная страница (SCREENS §10b `4j`)', () => {
  const page = renderPublicPage({
    title: 'Заметка о встрече',
    lead: 'Короткий лид',
    html: '<p>Тело заметки</p>',
    publishedAt: '2026-08-09T12:00:00.000Z',
  });

  it('колонка 620 и Source Serif 4', () => {
    expect(page).toContain('max-width: 620px');
    expect(page).toContain("'Source Serif 4'");
  });

  it('H1 40/600 и текст 18/1.75', () => {
    expect(page).toContain('h1 { font-size: 40px');
    expect(page).toContain('font-weight: 600');
    expect(page).toContain('font-size: 18px');
    expect(page).toContain('line-height: 1.75');
  });

  it('подвал строго по спецификации', () => {
    expect(page).toContain('Опубликовано из ЗАПИСОК · только чтение');
    expect(page).toContain('ЗАПИСКИ</span>');
  });

  it('никаких кнопок, шапок и призывов установить приложение', () => {
    expect(page).not.toContain('<button');
    expect(page).not.toContain('<header');
    expect(page).not.toContain('<nav');
    expect(page).not.toMatch(/установ/i);
    expect(page).not.toMatch(/скачать/i);
  });

  it('ни одного обращения наружу — визит никому не сообщается', () => {
    expect(page).not.toContain('<script');
    expect(page).not.toContain('googleapis');
    expect(page).not.toContain('cdn');
    expect(page).not.toContain('<link');
  });

  it('дата по-русски', () => {
    expect(page).toContain('9 августа 2026');
  });

  it('заголовок экранируется', () => {
    const evil = renderPublicPage({
      title: '<script>alert(1)</script>',
      lead: null,
      html: '',
      publishedAt: '2026-08-09T00:00:00.000Z',
    });
    expect(evil).not.toContain('<script>alert');
    expect(evil).toContain('&lt;script&gt;');
  });
});

/**
 * Период подписки.
 *
 * Жил в наборе ЮKassa и остался после её удаления: к провайдеру это отношения
 * не имеет — правило продукта одно на любой эквайринг.
 */
describe('период подписки', () => {
  it('считается по тарифу', () => {
    const start = new Date('2026-01-31T00:00:00Z');
    expect(periodEnd('yearly', start).getUTCFullYear()).toBe(2027);
    expect(periodEnd('monthly', new Date('2026-01-15T00:00:00Z')).toISOString()).toBe(
      '2026-02-15T00:00:00.000Z',
    );
  });

  it('годовой тариф — это двенадцать месячных цен, а не месячная', () => {
    expect(amountRub('yearly', { monthlyRub: 299, yearlyMonthlyRub: 224 })).toBe(2688);
    expect(amountRub('monthly', { monthlyRub: 299, yearlyMonthlyRub: 224 })).toBe(299);
  });
});

describe('фид обновлений', () => {
  it('сравнивает версии по semver', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });

  it('подбирает платформу по точному совпадению и по префиксу', () => {
    const manifest = {
      version: '1.0.0',
      notes: '',
      pub_date: '2026-08-09T00:00:00Z',
      platforms: {
        'windows-x86_64': { signature: 'sig', url: 'https://a/win.msi' },
        'android-universal': { signature: '', url: 'https://a/zapiski.apk' },
      },
    };
    expect(Object.keys(selectPlatforms(manifest, 'windows-x86_64'))).toEqual(['windows-x86_64']);
    expect(Object.keys(selectPlatforms(manifest, 'windows'))).toEqual(['windows-x86_64']);
    expect(Object.keys(selectPlatforms(manifest, 'android'))).toEqual(['android-universal']);
    expect(Object.keys(selectPlatforms(manifest, 'darwin'))).toEqual([]);
  });
});
