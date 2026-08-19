import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Подтверждение владения доменом для Android App Links.
 *
 * ── Что прислал заказчик ────────────────────────────────────────────────────
 *
 * «Android: после перехода из письма по кнопке в письме попадаешь на сайт
 * zapiski.cmpas.ru/promo, а не в приложение».
 *
 * Манифест объявляет `intent-filter` с `autoVerify="true"` на адрес ссылки из
 * письма — но система проверяет это объявление по файлу
 * `https://zapiski.cmpas.ru/.well-known/assetlinks.json`, а файла не было
 * нигде: ни в репозитории, ни на сайте. Непроверенные App Links Android
 * молча отдаёт браузеру.
 *
 * ── Почему тест смотрит на четыре файла сразу ───────────────────────────────
 *
 * Связка рвётся в любом из четырёх мест, и каждый разрыв беззвучен: отпечаток
 * ключа разошёлся с подписью APK, имя пакета разошлось с идентификатором
 * приложения, из манифеста пропал фильтр, файл перестал собираться в статику.
 * Ни одно из этих расхождений не роняет ни сборку, ни приложение — оно
 * проявляется только тем, что человек после письма оказывается в браузере.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const assetlinks = JSON.parse(
  readFileSync(path.join(root, 'apps/web/public/.well-known/assetlinks.json'), 'utf8'),
) as Array<{
  relation?: string[];
  target?: { namespace?: string; package_name?: string; sha256_cert_fingerprints?: string[] };
}>;

const expectedSigner = readFileSync(path.join(root, 'apps/mobile/EXPECTED_SIGNER.txt'), 'utf8')
  .trim()
  .toLowerCase();

const tauri = JSON.parse(
  readFileSync(path.join(root, 'apps/mobile/src-tauri/tauri.conf.json'), 'utf8'),
) as { identifier?: string };

const overlay = readFileSync(path.join(root, 'apps/mobile/scripts/apply-android-overlay.mjs'), 'utf8');

const entry = assetlinks[0];

describe('assetlinks.json', () => {
  it('объявляет ровно то отношение, которого ждёт Android', () => {
    expect(assetlinks).toHaveLength(1);
    expect(entry?.relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(entry?.target?.namespace).toBe('android_app');
  });

  it('называет тот же пакет, что и идентификатор приложения', () => {
    /* Имя пакета берётся из `identifier` в tauri.conf.json. Разойдутся —
       система не найдёт соответствия и отдаст ссылку браузеру. */
    expect(entry?.target?.package_name).toBe(tauri.identifier);
  });

  it('несёт отпечаток того же ключа, которым подписывается APK', () => {
    const fingerprints = entry?.target?.sha256_cert_fingerprints ?? [];
    expect(fingerprints).toHaveLength(1);

    /* В файле — заглавные шестнадцатеричные пары через двоеточие, таков
       формат Google. В EXPECTED_SIGNER.txt — то же самое в том виде, в каком
       его печатает keytool в CI. Сравниваем по существу, а не по написанию. */
    const normalized = String(fingerprints[0]).replace(/:/g, '').toLowerCase();
    expect(normalized).toBe(expectedSigner);
  });

  it('отпечаток — 64 шестнадцатеричных знака, а не заглушка', () => {
    expect(expectedSigner).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('манифест Android', () => {
  it('просит систему проверить владение доменом', () => {
    expect(overlay).toContain('android:autoVerify="true"');
  });

  it('перехватывает именно адрес ссылки из письма', () => {
    /* Ссылка ведёт в API: `/api/v1/auth/magic-link/callback`. Фильтр на один
       только `/auth` её не покрывает — это и есть тот случай, когда объявление
       выглядит правильным, а ссылка уходит в браузер. */
    expect(overlay).toContain('/api/v1/auth/magic-link/callback');
    expect(overlay).toContain('android:host="zapiski.cmpas.ru"');
  });

  it('оставляет свою схему отдельным фильтром', () => {
    /* `zapiski://` работает без подтверждения домена и служит запасным путём:
       сервер уводит браузер туда, когда App Links ещё не проверены. */
    expect(overlay).toContain('android:scheme="zapiski"');
  });
});
