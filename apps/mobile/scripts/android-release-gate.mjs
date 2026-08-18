#!/usr/bin/env node
/**
 * Шлюз production-подписи Android: что можно выкладывать людям, а что нельзя.
 *
 * ── Зачем ───────────────────────────────────────────────────────────────────
 *
 * Заказчик: «сейчас сертификат подписи в андроид блокируется проверкой при
 * установке и не проходит проверку Play Защиты». Корень — не в самом ключе, а
 * в цепочке: сборка работала fail-open. Нет секрета подписи — не падаем, а
 * берём ОТЛАДОЧНЫЙ ключ, собираем `--debug` и потом теми же строками кладём
 * получившееся в `/updates/latest/zapiski.apk`, откуда его качает человек по
 * кнопке на промостранице. То есть публичная ссылка могла отдавать сборку,
 * подписанную `CN=Android Debug`, — а это ровно то, на что Play Защита
 * реагирует в первую очередь.
 *
 * ── Почему логика здесь, а не в YAML ────────────────────────────────────────
 *
 * В YAML её нельзя проверить. Правила «когда сборка производственная», «что
 * делать при половине секретов» и «совпал ли отпечаток» — это ветвления, а
 * ветвления надо испытывать, а не перечитывать глазами. Здесь они лежат
 * чистыми функциями, и `test/android-release-gate.test.ts` прогоняет все
 * случаи из ТЗ (A–H) без единого секрета и без Android SDK.
 *
 * Секретов этот файл не видит: ему сообщают ЕСТЬ или НЕТ, а не значения.
 *
 * Запуск из workflow:
 *   node scripts/android-release-gate.mjs channel
 *   node scripts/android-release-gate.mjs policy
 *   node scripts/android-release-gate.mjs verify --expected <sha> --output <файл>
 *   node scripts/android-release-gate.mjs provenance --out <файл> …
 */

/** Отпечаток к одному виду: строчные шестнадцатеричные без двоеточий. */
export function normalizeFingerprint(value) {
  return String(value ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

/**
 * Канал сборки. ОДНО место, где это решается.
 *
 * ТЗ §5: «Не размазывать разные версии определения production по нескольким
 * shell-блокам». Ручной запуск производственным не становится сам: production
 * — это opt-in, иначе достаточно случайно выбрать не ту ветку.
 */
export function resolveChannel({
  refType = 'branch',
  refName = '',
  defaultBranch = '',
  eventName = 'push',
  inputChannel = '',
} = {}) {
  if (refType === 'tag') return 'production';
  if (eventName === 'workflow_dispatch') {
    return inputChannel === 'production' ? 'production' : 'development';
  }
  if (eventName === 'push' && refName !== '' && refName === defaultBranch) return 'production';
  return 'development';
}

const SECRET_NAMES = [
  'ANDROID_KEYSTORE_BASE64',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
];

/**
 * Что делать с этим комплектом секретов.
 *
 * Три состояния и ровно три исхода (ТЗ §6):
 *   все четыре            → релизная подпись;
 *   ни одного             → development собирает debug, production падает;
 *   часть                 → падаем ВСЕГДА, на любом канале.
 *
 * Последнее — не педантизм. Половина комплекта означает, что кто-то заводил
 * подпись и не довёл; молча собрать debug в этом случае значит спрятать
 * ошибку конфигурации именно там, где её дороже всего не заметить.
 */
export function signingPolicy({ channel = 'development', present = {} } = {}) {
  const missing = SECRET_NAMES.filter((name) => present[name] !== true);
  if (missing.length === 0) {
    return { buildType: 'release', signed: true, error: null };
  }
  if (missing.length < SECRET_NAMES.length) {
    return {
      buildType: null,
      signed: false,
      error:
        'Android signing configuration is incomplete. Expected all four ANDROID_* signing secrets. ' +
        `Не заданы: ${missing.join(', ')}.`,
    };
  }
  if (channel === 'production') {
    return {
      buildType: null,
      signed: false,
      error:
        'Производственная сборка без ключа подписи невозможна. ' +
        `Нужны все четыре секрета: ${SECRET_NAMES.join(', ')}.`,
    };
  }
  return { buildType: 'debug', signed: false, error: null };
}

/** Отпечаток сертификата из `keytool -list -v`. */
export function expectedSignerFromKeytool(text) {
  const match = /SHA256:\s*([0-9A-Fa-f:]+)/.exec(String(text ?? ''));
  return match ? normalizeFingerprint(match[1]) : '';
}

/**
 * Разбор `apksigner verify --verbose --print-certs`.
 *
 * Имена полей взяты из настоящего вывода инструмента, а не из головы: те же
 * строки разбирает работающий конвейер SignalAI, на который сослался заказчик.
 */
export function parseApksignerVerify(text) {
  const output = String(text ?? '');
  const scheme = (version) => {
    const found = new RegExp(`Verified using v${version} scheme[^\\n]*?:\\s*(true|false)`, 'i').exec(
      output,
    );
    return found ? found[1].toLowerCase() === 'true' : false;
  };
  const signers = [];
  for (const line of output.split('\n')) {
    const dn = /certificate DN:\s*(.+)$/i.exec(line.trim());
    if (dn) signers.push({ dn: dn[1].trim(), sha256: '' });
    const digest = /certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)/i.exec(line.trim());
    if (digest) {
      const value = normalizeFingerprint(digest[1]);
      if (signers.length === 0) signers.push({ dn: '', sha256: value });
      else signers[signers.length - 1].sha256 = value;
    }
  }
  return {
    verifies: /^Verifies\s*$/m.test(output),
    schemes: { v1: scheme(1), v2: scheme(2), v3: scheme(3), v4: scheme(4) },
    signers,
  };
}

/**
 * Годится ли готовый APK для людей.
 *
 * Проверяется ГОТОВЫЙ файл, а не намерение: «keystore восстановился» и «APK
 * подписан этим ключом» — разные утверждения, и до сих пор проверялось первое.
 */
export function verifySigner({ apksignerOutput = '', expectedSha256 = '', exitCode = 0 } = {}) {
  const problems = [];
  const report = parseApksignerVerify(apksignerOutput);
  const expected = normalizeFingerprint(expectedSha256);

  if (exitCode !== 0) problems.push(`apksigner verify завершился кодом ${exitCode}`);
  if (!report.verifies) problems.push('apksigner не подтвердил подпись (нет строки «Verifies»)');
  if (report.signers.length === 0) problems.push('в выводе apksigner нет ни одного подписанта');

  const debugSigner = report.signers.find((signer) => /CN=Android Debug/i.test(signer.dn));
  if (debugSigner) problems.push(`APK подписан отладочным ключом: ${debugSigner.dn}`);

  const actual = report.signers.find((signer) => signer.sha256 !== '')?.sha256 ?? '';
  if (expected === '') problems.push('не задан ожидаемый отпечаток из keystore');
  else if (actual === '') problems.push('в выводе apksigner нет отпечатка сертификата');
  else if (actual !== expected) {
    problems.push(`отпечаток APK ${actual} не совпал с ключом ${expected}`);
  }

  /* v2 обязательна: без неё пакет проверяется только по JAR-подписи, а это
     схема, от которой Android уходит с API 24. v3 желательна — она позволяет
     когда-нибудь сменить ключ без переустановки, и её отсутствие не повод
     останавливать выпуск. */
  if (!report.schemes.v2) problems.push('APK Signature Scheme v2 не подтверждена');
  const warnings = report.schemes.v3 ? [] : ['APK Signature Scheme v3 не подтверждена'];

  return {
    verified: problems.length === 0,
    actualSha256: actual,
    expectedSha256: expected,
    schemes: report.schemes,
    debugSigned: Boolean(debugSigner),
    problems,
    warnings,
  };
}

/** Можно ли трогать пользовательский канал выкладки. */
export function publishGate({ channel = 'development', verifiedRelease = false } = {}) {
  return channel === 'production' && verifiedRelease === true;
}

/** Паспорт сборки: что именно уехало людям и чем оно подписано. */
export function provenance({
  channel,
  version,
  applicationId,
  sourceRef,
  sourceSha,
  apkSha256,
  signerSha256,
  buildType,
  builtAt,
}) {
  return {
    schema_version: 1,
    channel,
    application_id: applicationId,
    version,
    source_ref: sourceRef,
    source_sha: sourceSha,
    apk_sha256: normalizeFingerprint(apkSha256),
    signer_certificate_sha256: normalizeFingerprint(signerSha256),
    build_type: buildType,
    debug_signed: buildType !== 'release',
    built_at: builtAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { readFileSync, writeFileSync, appendFileSync } = await import('node:fs');
  const [, , command, ...rest] = process.argv;
  const flag = (name, fallback = '') => {
    const at = rest.indexOf(`--${name}`);
    return at === -1 ? fallback : (rest[at + 1] ?? fallback);
  };
  const emit = (line) => {
    console.log(line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  };
  const fail = (message) => {
    console.error(`::error::${message}`);
    process.exit(1);
  };

  if (command === 'channel') {
    const channel = resolveChannel({
      refType: process.env.GITHUB_REF_TYPE ?? 'branch',
      refName: process.env.GITHUB_REF_NAME ?? '',
      defaultBranch: process.env.DEFAULT_BRANCH ?? '',
      eventName: process.env.GITHUB_EVENT_NAME ?? 'push',
      inputChannel: process.env.INPUT_CHANNEL ?? '',
    });
    emit(`channel=${channel}`);
    emit(`promoted=${channel === 'production' ? 'true' : 'false'}`);
  } else if (command === 'policy') {
    const present = Object.fromEntries(
      SECRET_NAMES.map((name) => [name, (process.env[`HAS_${name}`] ?? '') === 'true']),
    );
    const channel = process.env.CHANNEL ?? 'development';
    const policy = signingPolicy({ channel, present });
    if (policy.error) fail(policy.error);
    emit(`build_type=${policy.buildType}`);
    emit(`signed=${policy.signed ? 'true' : 'false'}`);
    console.log(`Android channel: ${channel}`);
    console.log(`Build type: ${policy.buildType}`);
    console.log(
      `Signing config: ${policy.signed ? 'ANDROID_* complete' : 'нет ключа — только development'}`,
    );
  } else if (command === 'verify') {
    const outcome = verifySigner({
      apksignerOutput: readFileSync(flag('output'), 'utf8'),
      expectedSha256: flag('expected', process.env.EXPECTED_SIGNER_SHA256 ?? ''),
      exitCode: Number(flag('exit-code', '0')),
    });
    for (const warning of outcome.warnings) console.log(`::warning::${warning}`);
    if (!outcome.verified) {
      for (const problem of outcome.problems) console.error(`::error::${problem}`);
      emit('verified_release=false');
      console.error('Production publish gate: CLOSED');
      process.exit(1);
    }
    emit(`signer_sha256=${outcome.actualSha256}`);
    emit('verified_release=true');
    console.log(`APK signer SHA-256: ${outcome.actualSha256}`);
    console.log('Signature verification: PASS');
    console.log('Production publish gate: OPEN');
  } else if (command === 'provenance') {
    const target = flag('out', 'zapiski-android.json');
    const body = provenance({
      channel: flag('channel', 'development'),
      version: flag('version', '0.0.0'),
      applicationId: flag('application-id', 'ru.cmpas.zapiski'),
      sourceRef: process.env.GITHUB_REF_NAME ?? '',
      sourceSha: process.env.GITHUB_SHA ?? '',
      apkSha256: flag('apk-sha256', ''),
      signerSha256: flag('signer-sha256', ''),
      buildType: flag('build-type', 'debug'),
      builtAt: flag('built-at', new Date().toISOString()),
    });
    writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`Паспорт сборки: ${target}`);
    console.log(JSON.stringify(body, null, 2));
  } else {
    fail(`неизвестная команда «${command ?? ''}»: channel | policy | verify | provenance`);
  }
}
