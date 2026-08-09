import { describe, expect, it } from 'vitest';
import { WebCryptoProvider } from '../src/crypto/provider.js';
import { decodeContainer, encodeContainer } from '../src/crypto/container.js';
import { markdownToHtml, renderPrintableHtml } from '../src/export/html.js';
import type { Note } from '../src/contract.js';

const fast = { iterations: 1, memorySize: 1024, parallelism: 1, hashLength: 32 };

describe('crypto probe', () => {
  it('nonce uniqueness across encryptions', async () => {
    const p = new WebCryptoProvider({ argon2: fast });
    const salt = p.randomSalt();
    const key = await p.deriveMasterKey('пароль', salt);
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const c = decodeContainer(await p.encrypt('одно и то же', key))!;
      nonces.add(Buffer.from(c.nonce).toString('hex'));
    }
    console.log('unique nonces', nonces.size, 'of 200');
    expect(nonces.size).toBe(200);
  });

  it('AAD: header tampering', async () => {
    const p = new WebCryptoProvider({ argon2: fast });
    const salt = p.randomSalt();
    const key = await p.deriveMasterKey('пароль', salt);
    const blob = await p.encrypt('секретный текст', key, 'девичья фамилия матери');
    const parsed = decodeContainer(blob)!;
    console.log('original hint:', parsed.hint);
    // Подменяем ТОЛЬКО подсказку, шифротекст не трогаем.
    const evil = encodeContainer({ ...parsed, hint: 'введите пароль от почты' });
    const out = await p.decrypt(evil, key);
    console.log('decrypt after hint tamper ->', JSON.stringify(out));
    console.log('hint after tamper ->', p.parseHeader(evil)?.hint);
  });

  it('truncated / corrupted containers', async () => {
    const p = new WebCryptoProvider({ argon2: fast });
    const salt = p.randomSalt();
    const key = await p.deriveMasterKey('пароль', salt);
    const blob = await p.encrypt('текст', key);
    for (const n of [0, 1, 5, 9, 10, 15, blob.length - 1]) {
      const cut = blob.slice(0, n);
      const r = await p.decrypt(cut, key);
      console.log('truncate to', n, '->', r);
    }
    const flipped = Uint8Array.from(blob);
    flipped[flipped.length - 1] ^= 0xff;
    console.log('tag flip ->', await p.decrypt(flipped, key));
    const wrongKey = await p.deriveMasterKey('другой', salt);
    console.log('wrong password ->', await p.decrypt(blob, wrongKey));
  });
});

describe('export html probe', () => {
  it('javascript: urls in exported html', () => {
    const md = [
      '[клик](javascript:alert(document.domain))',
      '![](javascript:alert(1))',
      '[[javascript:alert(2)]]',
      '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
      '<script>alert(3)</script>',
      '[y](vbscript:msgbox(1))',
    ].join('\n\n');
    const html = markdownToHtml(md);
    console.log(html);
    const note: Note = {
      path: 'a.md', title: 'a', body: md, snippet: '', tags: [], createdAt: 0, updatedAt: 0,
    } as unknown as Note;
    console.log('---printable---');
    console.log(renderPrintableHtml(note).slice(0, 200));
  });
});
