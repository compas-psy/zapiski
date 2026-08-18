/**
 * Шлюз production-подписи: восемь случаев из ТЗ заказчика (§18, A–H).
 *
 * ── Что было ────────────────────────────────────────────────────────────────
 *
 * Заказчик: «сертификат подписи в андроид блокируется проверкой при установке
 * и не проходит проверку Play Защиты». Причина не в ключе, а в цепочке: сборка
 * работала fail-open. Нет секретов подписи — не падаем, берём ОТЛАДОЧНЫЙ ключ,
 * собираем `--debug`, и дальше те же строки кладут результат в
 * `/updates/latest/zapiski.apk` — файл, который человек скачивает по кнопке.
 * То есть публичная ссылка могла отдавать пакет с `CN=Android Debug`.
 *
 * ── Почему проверки здесь ───────────────────────────────────────────────────
 *
 * Ветвления «когда сборка производственная», «что делать при половине
 * секретов» и «совпал ли отпечаток» в YAML не испытать: там нет ни функций, ни
 * входов. Поэтому они вынесены в `scripts/android-release-gate.mjs`, а этот
 * файл прогоняет их на выдуманных, но точных входах — без секретов, без
 * Android SDK и без устройства.
 *
 * Настоящий отпечаток настоящего APK так не проверить: это делает шаг
 * `verify` в самом workflow на живом ключе. Здесь проверяется правило, а не
 * артефакт.
 */
import { describe, expect, it } from 'vitest';

import {
  normalizeFingerprint,
  parseApksignerVerify,
  provenance,
  publishGate,
  resolveChannel,
  signingPolicy,
  verifySigner,
  expectedSignerFromKeytool,
} from '../scripts/android-release-gate.mjs';

const ALL_SECRETS = {
  ANDROID_KEYSTORE_BASE64: true,
  ANDROID_KEYSTORE_PASSWORD: true,
  ANDROID_KEY_ALIAS: true,
  ANDROID_KEY_PASSWORD: true,
};

/** Вывод `apksigner verify --verbose --print-certs` — по форме настоящего. */
function apksignerOutput({
  dn = 'CN=ZAPISKI, OU=compas-psy, O=SIMPAS',
  sha256 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
  v1 = true,
  v2 = true,
  v3 = true,
} = {}): string {
  return [
    'Verifies',
    `Verified using v1 scheme (JAR signing): ${v1}`,
    `Verified using v2 scheme (APK Signature Scheme v2): ${v2}`,
    `Verified using v3 scheme (APK Signature Scheme v3): ${v3}`,
    'Verified using v4 scheme (APK Signature Scheme v4): false',
    'Number of signers: 1',
    `Signer #1 certificate DN: ${dn}`,
    `Signer #1 certificate SHA-256 digest: ${sha256}`,
  ].join('\n');
}

const OURS = normalizeFingerprint(
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
);

describe('канал сборки решается в одном месте', () => {
  it('тег — всегда production', () => {
    expect(resolveChannel({ refType: 'tag', refName: 'v0.2.0', eventName: 'push' })).toBe(
      'production',
    );
  });

  it('пуш в ветку по умолчанию — production: её сборки предлагает промостраница', () => {
    expect(
      resolveChannel({ refName: 'release-line', defaultBranch: 'release-line', eventName: 'push' }),
    ).toBe('production');
  });

  it('чужая ветка и pull request — development', () => {
    expect(
      resolveChannel({ refName: 'feature/x', defaultBranch: 'release-line', eventName: 'push' }),
    ).toBe('development');
    expect(resolveChannel({ refName: 'feature/x', eventName: 'pull_request' })).toBe('development');
  });

  it('ручной запуск производственным не становится сам — только явным выбором', () => {
    expect(resolveChannel({ eventName: 'workflow_dispatch', refName: 'release-line', defaultBranch: 'release-line' })).toBe(
      'development',
    );
    expect(
      resolveChannel({ eventName: 'workflow_dispatch', inputChannel: 'production' }),
    ).toBe('production');
  });
});

describe('комплект секретов проверяется целиком', () => {
  it('A. production + полный комплект — релизная сборка', () => {
    const policy = signingPolicy({ channel: 'production', present: ALL_SECRETS });
    expect(policy.error).toBeNull();
    expect(policy.buildType).toBe('release');
    expect(policy.signed).toBe(true);
  });

  it('B. production без секретов — отказ, а не debug', () => {
    const policy = signingPolicy({ channel: 'production', present: {} });
    expect(policy.buildType).toBeNull();
    expect(policy.error, 'production без ключа обязан падать').toBeTruthy();
  });

  it('C. половина комплекта — отказ на ЛЮБОМ канале', () => {
    const half = { ANDROID_KEYSTORE_BASE64: true, ANDROID_KEY_ALIAS: true };
    for (const channel of ['production', 'development']) {
      const policy = signingPolicy({ channel, present: half });
      expect(policy.error, `${channel}: половина комплекта прошла как норма`).toContain(
        'incomplete',
      );
    }
  });

  it('D. development без секретов — debug допустим', () => {
    const policy = signingPolicy({ channel: 'development', present: {} });
    expect(policy.error).toBeNull();
    expect(policy.buildType).toBe('debug');
    expect(policy.signed).toBe(false);
  });
});

describe('готовый APK проверяется, а не намерение', () => {
  it('свой ключ, схемы v2 и v3 — выпуск разрешён', () => {
    const outcome = verifySigner({ apksignerOutput: apksignerOutput(), expectedSha256: OURS });
    expect(outcome.problems).toEqual([]);
    expect(outcome.verified).toBe(true);
    expect(outcome.actualSha256).toBe(OURS);
  });

  it('E. отладочный сертификат — жёсткий отказ', () => {
    const outcome = verifySigner({
      apksignerOutput: apksignerOutput({ dn: 'CN=Android Debug, O=Android, C=US' }),
      expectedSha256: OURS,
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.debugSigned).toBe(true);
    expect(outcome.problems.join(' ')).toContain('отладочным ключом');
  });

  it('F. отпечаток не совпал с keystore — жёсткий отказ', () => {
    const outcome = verifySigner({
      apksignerOutput: apksignerOutput({ sha256: '00:11:22:33' }),
      expectedSha256: OURS,
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.problems.join(' ')).toContain('не совпал');
  });

  it('apksigner упал — отказ, даже если текст выглядит правильным', () => {
    const outcome = verifySigner({
      apksignerOutput: apksignerOutput(),
      expectedSha256: OURS,
      exitCode: 1,
    });
    expect(outcome.verified).toBe(false);
  });

  it('без схемы v2 выпуск не проходит, без v3 — только предупреждение', () => {
    const withoutV2 = verifySigner({
      apksignerOutput: apksignerOutput({ v2: false }),
      expectedSha256: OURS,
    });
    expect(withoutV2.verified).toBe(false);

    const withoutV3 = verifySigner({
      apksignerOutput: apksignerOutput({ v3: false }),
      expectedSha256: OURS,
    });
    expect(withoutV3.verified).toBe(true);
    expect(withoutV3.warnings.join(' ')).toContain('v3');
  });

  it('пустой вывод не считается успехом', () => {
    expect(verifySigner({ apksignerOutput: '', expectedSha256: OURS }).verified).toBe(false);
  });

  it('отпечаток keystool и apksigner приводятся к одному виду', () => {
    const keytool = 'Certificate fingerprints:\n\t SHA256: AA:BB:CC:DD\n';
    expect(expectedSignerFromKeytool(keytool)).toBe('aabbccdd');
    expect(parseApksignerVerify(apksignerOutput()).signers[0]?.sha256).toBe(OURS);
  });
});

describe('пользовательский канал открывается только проверенной сборке', () => {
  it('G. сборка чужой ветки не трогает latest даже при доступном сервере', () => {
    expect(publishGate({ channel: 'development', verifiedRelease: true })).toBe(false);
  });

  it('H. тег без пройденной проверки не публикуется', () => {
    expect(publishGate({ channel: 'production', verifiedRelease: false })).toBe(false);
    expect(publishGate({ channel: 'production', verifiedRelease: true })).toBe(true);
  });
});

describe('паспорт сборки', () => {
  it('несёт обе суммы и честно называет тип сборки', () => {
    const body = provenance({
      channel: 'production',
      version: '0.1.0',
      applicationId: 'ru.cmpas.zapiski',
      sourceRef: 'v0.1.0',
      sourceSha: 'abc',
      apkSha256: 'DE:AD:BE:EF',
      signerSha256: OURS,
      buildType: 'release',
      builtAt: '2026-08-18T12:00:00.000Z',
    });
    expect(body.apk_sha256).toBe('deadbeef');
    expect(body.signer_certificate_sha256).toBe(OURS);
    expect(body.debug_signed).toBe(false);
    /* Ни паролей, ни keystore: паспорт ездит рядом с APK и попадает в релиз. */
    expect(JSON.stringify(body)).not.toMatch(/password|keystore|base64/i);
  });

  it('у debug-сборки честно стоит debug_signed', () => {
    expect(provenance({ buildType: 'debug' } as never).debug_signed).toBe(true);
  });
});
