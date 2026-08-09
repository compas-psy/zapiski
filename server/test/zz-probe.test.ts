import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHarness, createUser, noDatabase, type Harness } from './helpers/app.ts';
import { sanitizeHtml } from '../src/lib/sanitizeHtml.ts';

describe.skipIf(noDatabase())('probe', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness({ env: { YOOKASSA_ALLOWED_CIDRS: '185.71.76.0/27' } }); });
  afterAll(async () => { await h.close(); });

  it('XFF spoofing -> request.ip', async () => {
    const user = await createUser(h);
    const r = await h.app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { ...user.authHeader, 'x-forwarded-for': '185.71.76.5, 10.0.0.1' },
    });
    expect(r.statusCode).toBe(200);
    // Now hit the webhook with a spoofed source
    const w = await h.app.inject({
      method: 'POST', url: '/api/v1/billing/yookassa/webhook',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '185.71.76.5' },
      payload: { event: 'payment.succeeded', object: { id: 'probe-1', status: 'succeeded', paid: true, metadata: { user_id: user.userId, plan: 'yearly' } } },
    });
    console.log('WEBHOOK spoofed status', w.statusCode, w.body);
    const s = await h.app.inject({ method: 'GET', url: '/api/v1/billing/status', headers: user.authHeader });
    console.log('BILLING', s.body);
  });

  it('path traversal probes', async () => {
    const user = await createUser(h);
    const paths = [
      '../../../../etc/passwd',
      '..%2f..%2f..%2fetc%2fpasswd',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '%252e%252e%252fetc%252fpasswd',
      'a/../../b.md',
      'foo%00.md',
      '/etc/passwd',
      '....//....//etc/passwd',
    ];
    for (const p of paths) {
      const r = await h.app.inject({
        method: 'PUT', url: `/api/v1/vault/blob/${p}`,
        headers: { ...user.authHeader, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('x'),
      });
      console.log('PUT', JSON.stringify(p), '->', r.statusCode, r.body.slice(0, 120));
    }
  });

  it('sanitizer probes', () => {
    const vectors = [
      '<img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="jAvAsCrIpT:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<svg onload=alert(1)>',
      '<div><script>alert(1)</script></div>',
      '<p title="a>b" onmouseover="alert(1)">z</p>',
      '<a href="/x" onclick=alert(1)>y</a>',
      '<style>@import "x"</style>',
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
      '<a href=" javascript:alert(1)">x</a>',
      '<a href="java\tscript:alert(1)">x</a>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<form><button formaction=javascript:alert(1)>x',
      '<a href="//evil.example/">x</a>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<xmp><p>a</xmp><img src=x onerror=alert(1)>',
    ];
    for (const v of vectors) console.log(JSON.stringify(v), '=>', JSON.stringify(sanitizeHtml(v).html));
  });
});
