#!/usr/bin/env node
/**
 * Гейт «Уязвимости в зависимостях»: high/critical падают жёстко, но падение
 * реестра — не «нашли уязвимость».
 *
 * ── Зачем это существует ─────────────────────────────────────────────────
 *
 * closure-pass CI-прогон на 3872bcf: `pnpm audit --audit-level high` дважды
 * подряд упал по ERR_SOCKET_TIMEOUT к registry.npmjs.org — не по найденной
 * уязвимости, — а красный статус джобы неотличим по голому exit-коду от
 * «нашли high». В workflow уже стоял npm audit по production-графу
 * (`server/package-lock.json`) как подразумеваемый fallback, но без
 * условия запуска: сбой pnpm-шага останавливал job целиком (шаг просто
 * skipped), и fallback никогда фактически не срабатывал.
 *
 * Правило продиктовано явно: не слабить audit-level, не добавлять `|| true`
 * на high/critical, различать «реально нашли» и «реестр недоступен»,
 * ограниченное число повторов, а если провайдер исчерпал повторы именно по
 * сетевой причине — джоба обязана остаться FAILED, не GREEN.
 *
 * ── pnpm workspace И npm production graph — оба ВСЕГДА, оба authoritative ──
 *
 * pnpm-lock.yaml и server/package-lock.json — независимые графы: npm не
 * читает pnpm.overrides, а образ прода собирается `npm ci` именно по
 * server/package-lock.json (deploy/api.Dockerfile). Найдено фактом: этот
 * lock-файл расходился с pnpm-графом больше двух недель, и «чистый pnpm»
 * никак не показывал расхождение. Поэтому модель не «pnpm чист → npm можно
 * не спрашивать» и не «сбой pnpm → fallback на npm», а оба audit ВСЕГДА
 * выполняются, и оба обязаны дать authoritative-ответ: находка в любом
 * графе — FAIL; сетевой/неясный сбой любого графа держит джобу FAILED, пока
 * именно этот граф не подтверждён чистым — чистота другого графа тут ничего
 * не доказывает.
 *
 * ── Как различаем находку и сетевой сбой ─────────────────────────────────
 *
 * `pnpm audit` имеет штатный флаг `--ignore-registry-errors` (exit 0 именно
 * когда упал реестр, а не порог) — это authoritative-сигнал от самого
 * инструмента, не наша догадка по regex. `npm audit` такого флага не имеет:
 * там разбор `--json`-вывода (валидный отчёт со счётчиками → доверяем
 * цифрам) плюс текстовые сигнатуры сетевого сбоя как запасной путь — но
 * НИКОГДА как доказательство «чисто»: без структурированного отчёта решение
 * — «неясно», не «зелено».
 *
 * Самопроверка — где угодно, сеть не нужна:
 *   node scripts/audit-gate.mjs --self-test
 *
 * Запуск в CI (см. .github/workflows/security.yml, джоба `audit`):
 *   node scripts/audit-gate.mjs run
 */
import { spawnSync } from 'node:child_process';

// ── 1. Классификация одного прогона `audit --json` ──────────────────────

const TRANSPORT_ERROR_PATTERN =
  /ERR_SOCKET_TIMEOUT|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_PNPM_AUDIT_BAD_RESPONSE|socket hang up|network timeout|request to .* failed|getaddrinfo|EHOSTUNREACH/i;

export function isTransportErrorText(text) {
  return TRANSPORT_ERROR_PATTERN.test(String(text ?? ''));
}

/**
 * Счётчики уязвимостей из `--json`-вывода pnpm/npm audit — форма
 * `metadata.vulnerabilities.{critical,high,moderate,low}` общая у обоих
 * инструментов. `null`, если вывод не распознан как валидный отчёт.
 */
export function parseVulnerabilityCounts(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout ?? ''));
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return null;
  // npm кладёт сетевую ошибку в этот конверт вместо отчёта.
  if ('error' in data) return null;
  const counts = data.metadata && data.metadata.vulnerabilities;
  if (counts === null || typeof counts !== 'object') return null;
  return {
    critical: Number(counts.critical ?? 0),
    high: Number(counts.high ?? 0),
    moderate: Number(counts.moderate ?? 0),
    low: Number(counts.low ?? 0),
  };
}

/**
 * Итог одного прогона:
 *   'clean'           — валидный отчёт, high+critical = 0;
 *   'vulnerable'      — валидный отчёт, high или critical > 0: РЕАЛЬНАЯ
 *                        находка — ретраить и переключаться на fallback
 *                        нельзя, это не сеть;
 *   'transport-error' — реестр недоступен: pnpm сам сказал через
 *                        `--ignore-registry-errors` (exit 0 без отчёта),
 *                        либо текст похож на сетевой сбой;
 *   'unknown'         — ни отчёта, ни сетевой сигнатуры, но и не exit 0:
 *                        тоже не «чисто» — решение остаётся «неясно».
 *
 * `usesIgnoreRegistryErrors` — вызывался ли `audit` с этим флагом: тогда
 * «exit 0 без валидного отчёта» само по себе означает сетевой сбой
 * (задокументированный смысл флага), а не «повезло, посчитаем чистым».
 */
export function classifyAuditRun({ exitCode, stdout, stderr, usesIgnoreRegistryErrors = false }) {
  const counts = parseVulnerabilityCounts(stdout);
  if (counts !== null) {
    return { status: counts.critical > 0 || counts.high > 0 ? 'vulnerable' : 'clean', counts };
  }
  if (exitCode === 0) {
    if (usesIgnoreRegistryErrors) return { status: 'transport-error', counts: null };
    // Нулевой exit без отчёта и без этого флага — не должно происходить
    // на практике (audit печатает JSON при успехе), но раз уж случилось —
    // не объявляем «чисто» без структурированного доказательства.
    return { status: 'unknown', counts: null };
  }
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
  if (isTransportErrorText(combined)) return { status: 'transport-error', counts: null };
  return { status: 'unknown', counts: null };
}

// ── 2. Повторы одного провайдера ─────────────────────────────────────────

const RETRYABLE_STATUSES = new Set(['transport-error', 'unknown']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `run(attemptNumber)` обязан вернуть `{ exitCode, stdout, stderr }`.
 * Останавливается на первом authoritative-результате (clean/vulnerable);
 * ретраит только сетевые/неясные сбои, и только `attempts` раз.
 */
export async function auditProviderWithRetries({
  name,
  run,
  attempts = 2,
  delayMs = (attempt) => attempt * 15000,
  usesIgnoreRegistryErrors = false,
  sleepFn = sleep,
}) {
  const log = [];
  let last = { status: 'unknown', counts: null };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await run(attempt);
    const classified = classifyAuditRun({ ...result, usesIgnoreRegistryErrors });
    log.push({ attempt, status: classified.status, counts: classified.counts });
    last = classified;
    if (!RETRYABLE_STATUSES.has(classified.status)) {
      return { provider: name, ...classified, attempts: log };
    }
    if (attempt < attempts) await sleepFn(delayMs(attempt));
  }
  return { provider: name, ...last, attempts: log };
}

// ── 3. Оркестрация: pnpm workspace И npm production graph — оба всегда ───

/**
 * pnpm-lock.yaml и server/package-lock.json — два независимых графа
 * зависимостей (npm не читает pnpm.overrides), и образ прода собирается
 * ИМЕННО по второму (`npm ci`, deploy/api.Dockerfile). Поэтому оба audit
 * ВСЕГДА выполняются и оба authoritative — не «pnpm чист → npm можно не
 * спрашивать»: чистый pnpm ничего не доказывает про server/package-lock.json.
 *
 * `pnpmRun`/`npmRun` — функции `(attempt) => Promise<{exitCode, stdout,
 * stderr}>`, что принимает `auditProviderWithRetries`.
 */
export async function runAuditGate({
  pnpmRun,
  npmRun,
  pnpmAttempts = 2,
  npmAttempts = 2,
  delayMs = (attempt) => attempt * 15000,
  sleepFn = sleep,
}) {
  const pnpm = await auditProviderWithRetries({
    name: 'pnpm',
    run: pnpmRun,
    attempts: pnpmAttempts,
    delayMs,
    usesIgnoreRegistryErrors: true,
    sleepFn,
  });
  const npm = await auditProviderWithRetries({
    name: 'npm',
    run: npmRun,
    attempts: npmAttempts,
    delayMs,
    usesIgnoreRegistryErrors: false,
    sleepFn,
  });
  return { pnpm, npm };
}

/**
 * Итоговый вердикт джобы — по ОБОИМ графам сразу:
 *   ok: true             — оба графа дали структурированный чистый отчёт;
 *   reason 'vulnerable'  — хотя бы один граф РЕАЛЬНО нашёл high/critical
 *                          (находка в одном не гасится чистотой другого);
 *   reason 'inconclusive'— ни одной находки, но хотя бы один граф не дал
 *                          authoritative-ответа (сеть/неясно) — «чист
 *                          pnpm» не является доказательством «чист npm»,
 *                          так что непроверенный граф держит джобу FAILED.
 */
export function auditVerdict({ pnpm, npm }) {
  if (pnpm.status === 'vulnerable' || npm.status === 'vulnerable') {
    return { ok: false, reason: 'vulnerable' };
  }
  if (pnpm.status === 'clean' && npm.status === 'clean') {
    return { ok: true, reason: 'clean' };
  }
  return { ok: false, reason: 'inconclusive' };
}

// ── 4. CLI: реальные `pnpm audit` / `npm audit` через child_process ─────

function runCommand(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function cliMain() {
  const repoRoot = new URL('..', import.meta.url).pathname;
  const serverDir = new URL('../server', import.meta.url).pathname;

  const pnpmRun = async (attempt) => {
    console.log(`::group::pnpm audit (воркспейс), попытка ${attempt}`);
    const result = runCommand(
      'pnpm',
      ['audit', '--audit-level', 'high', '--json', '--ignore-registry-errors'],
      { cwd: repoRoot },
    );
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    console.log('::endgroup::');
    return result;
  };

  const npmRun = async (attempt) => {
    console.log(`::group::npm audit (граф, который реально едет в прод), попытка ${attempt}`);
    const result = runCommand('npm', ['audit', '--audit-level=high', '--json'], {
      cwd: serverDir,
    });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    console.log('::endgroup::');
    return result;
  };

  const result = await runAuditGate({ pnpmRun, npmRun });
  const verdict = auditVerdict(result);
  const describe = (r) =>
    r.counts
      ? `high=${r.counts.high} critical=${r.counts.critical} moderate=${r.counts.moderate} low=${r.counts.low}`
      : `статус=${r.status} (структурированного отчёта нет)`;

  console.log('--- итог dependency-audit ---');
  console.log(`pnpm workspace (pnpm-lock.yaml): ${describe(result.pnpm)}`);
  console.log(`попытки pnpm: ${JSON.stringify(result.pnpm.attempts)}`);
  console.log(`npm production graph (server/package-lock.json): ${describe(result.npm)}`);
  console.log(`попытки npm: ${JSON.stringify(result.npm.attempts)}`);

  if (verdict.ok) {
    console.log(
      'вердикт: OK — оба графа (pnpm workspace, npm production) подтверждены чистыми ' +
        'структурированным отчётом.',
    );
    process.exit(0);
  }
  if (verdict.reason === 'vulnerable') {
    console.error(
      `::error::dependency-audit: найдены high/critical — pnpm: ${describe(result.pnpm)}; npm: ${describe(result.npm)}.`,
    );
    process.exit(1);
  }
  console.error(
    '::error::dependency-audit: НЕЯСНО — по крайней мере один из графов (pnpm workspace, npm ' +
      'production) не дал структурированного отчёта после повторов. Чистота другого графа это не ' +
      'доказывает: джоба остаётся FAILED, а не GREEN, пока ОБА графа не подтверждены реальным ' +
      `отчётом. pnpm: ${describe(result.pnpm)}; npm: ${describe(result.npm)}.`,
  );
  process.exit(1);
}

// ── 5. Самопроверка ───────────────────────────────────────────────────────

async function selfTest() {
  const checks = [];
  const check = (name, condition) => checks.push({ name, ok: Boolean(condition) });

  const cleanJson = JSON.stringify({
    metadata: { vulnerabilities: { critical: 0, high: 0, moderate: 2, low: 0 } },
  });
  const vulnerableJson = JSON.stringify({
    metadata: { vulnerabilities: { critical: 0, high: 8, moderate: 2, low: 0 } },
  });
  const npmErrorEnvelope = JSON.stringify({ error: { code: 'ETIMEDOUT' } });

  check(
    'валидный чистый отчёт распознаётся как clean',
    classifyAuditRun({ exitCode: 1, stdout: cleanJson, stderr: '' }).status === 'clean',
  );
  check(
    'валидный отчёт с high распознаётся как vulnerable, а не как сеть',
    classifyAuditRun({ exitCode: 1, stdout: vulnerableJson, stderr: '' }).status === 'vulnerable',
  );
  check(
    'находка не путается с транспортной ошибкой, даже если текст рядом похож на сеть',
    classifyAuditRun({
      exitCode: 1,
      stdout: vulnerableJson,
      stderr: 'warning: slow network',
    }).status === 'vulnerable',
  );
  check(
    '--ignore-registry-errors + exit 0 без отчёта = transport-error, не clean',
    classifyAuditRun({ exitCode: 0, stdout: '', stderr: '', usesIgnoreRegistryErrors: true })
      .status === 'transport-error',
  );
  check(
    'exit 0 без отчёта и БЕЗ флага — не объявляется чистым (unknown, не clean)',
    classifyAuditRun({ exitCode: 0, stdout: '', stderr: '' }).status === 'unknown',
  );
  check(
    'реальный текст ERR_SOCKET_TIMEOUT из CI распознаётся как transport-error',
    classifyAuditRun({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERR_SOCKET_TIMEOUT  A timeout occurred while communicating with registry.npmjs.org',
    }).status === 'transport-error',
  );
  check(
    'npm-конверт с ошибкой реестра — transport-error, не clean',
    classifyAuditRun({ exitCode: 1, stdout: npmErrorEnvelope, stderr: '' }).status ===
      'transport-error',
  );
  check(
    'непонятный сбой без отчёта и без сетевой сигнатуры — unknown, не clean',
    classifyAuditRun({ exitCode: 1, stdout: 'boom', stderr: 'stack trace' }).status === 'unknown',
  );

  // ── Провайдер с повторами (delayMs зануляется — самопроверка не ждёт) ──
  {
    let calls = 0;
    const alwaysNetwork = async () => {
      calls += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const p = await auditProviderWithRetries({
      name: 'test',
      run: alwaysNetwork,
      attempts: 3,
      delayMs: () => 0,
      usesIgnoreRegistryErrors: true,
    });
    check('исчерпывает ровно заданное число попыток при непрекращающейся сети', calls === 3);
    check(
      'после исчерпания попыток статус остаётся transport-error, не clean',
      p.status === 'transport-error',
    );
  }
  {
    let calls = 0;
    const failsThenClean = async () => {
      calls += 1;
      if (calls === 1) return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: cleanJson, stderr: '' };
    };
    const p = await auditProviderWithRetries({
      name: 'test',
      run: failsThenClean,
      attempts: 3,
      delayMs: () => 0,
      usesIgnoreRegistryErrors: true,
    });
    check('второй попытки достаточно, если первая — сеть, а вторая — чистый отчёт', calls === 2);
    check('итог после восстановления сети — clean', p.status === 'clean');
  }
  {
    let calls = 0;
    const findsVulnerableFirstTry = async () => {
      calls += 1;
      return { exitCode: 1, stdout: vulnerableJson, stderr: '' };
    };
    const p = await auditProviderWithRetries({
      name: 'test',
      run: findsVulnerableFirstTry,
      attempts: 3,
      delayMs: () => 0,
      usesIgnoreRegistryErrors: true,
    });
    check('реальная находка не ретраится — одна попытка', calls === 1);
    check('вердикт — vulnerable, ретраи не маскируют находку', p.status === 'vulnerable');
  }

  // ── Оркестрация: pnpm workspace И npm production — оба ВСЕГДА, оба authoritative ──
  {
    let pnpmCalls = 0;
    let npmCalls = 0;
    const pnpmClean = async () => {
      pnpmCalls += 1;
      return { exitCode: 0, stdout: cleanJson, stderr: '' };
    };
    const npmClean = async () => {
      npmCalls += 1;
      return { exitCode: 0, stdout: cleanJson, stderr: '' };
    };
    const result = await runAuditGate({ pnpmRun: pnpmClean, npmRun: npmClean, delayMs: () => 0 });
    check('npm ВСЕГДА вызывается, даже когда pnpm уже чист', npmCalls > 0);
    check('pnpm тоже вызывается', pnpmCalls > 0);
    check('оба графа чисты → OK', auditVerdict(result).ok === true);
  }
  {
    // Ровно тот сценарий, который нашли фактом: pnpm-lock.yaml чист, а
    // server/package-lock.json (граф прод-образа) — нет. Чистота pnpm НЕ
    // должна давать зелёный вердикт.
    let npmCalls = 0;
    const pnpmClean = async () => ({ exitCode: 0, stdout: cleanJson, stderr: '' });
    const npmVulnerable = async () => {
      npmCalls += 1;
      return { exitCode: 1, stdout: vulnerableJson, stderr: '' };
    };
    const result = await runAuditGate({
      pnpmRun: pnpmClean,
      npmRun: npmVulnerable,
      delayMs: () => 0,
    });
    check('npm реально проверяется, даже когда pnpm чист', npmCalls > 0);
    check(
      'чистый pnpm не маскирует находку в npm production graph',
      auditVerdict(result).ok === false && auditVerdict(result).reason === 'vulnerable',
    );
  }
  {
    // Симметрично: находка в pnpm workspace тоже не гасится чистым npm.
    const pnpmVulnerable = async () => ({ exitCode: 1, stdout: vulnerableJson, stderr: '' });
    const npmClean = async () => ({ exitCode: 0, stdout: cleanJson, stderr: '' });
    const result = await runAuditGate({
      pnpmRun: pnpmVulnerable,
      npmRun: npmClean,
      delayMs: () => 0,
    });
    check(
      'чистый npm не маскирует находку в pnpm workspace graph',
      auditVerdict(result).ok === false && auditVerdict(result).reason === 'vulnerable',
    );
  }
  {
    // Транспортный сбой ровно одного графа: другой граф чист, но это не
    // разрешает объявить весь gate зелёным — непроверенный граф остаётся
    // непроверенным.
    const pnpmClean = async () => ({ exitCode: 0, stdout: cleanJson, stderr: '' });
    const npmNetworkDown = async () => ({ exitCode: 1, stdout: '', stderr: 'ETIMEDOUT' });
    const result = await runAuditGate({
      pnpmRun: pnpmClean,
      npmRun: npmNetworkDown,
      delayMs: () => 0,
    });
    const verdict = auditVerdict(result);
    check(
      'сетевой сбой ОДНОГО графа не даёт OK, даже если другой граф чист',
      verdict.ok === false && verdict.reason === 'inconclusive',
    );
  }
  {
    const bothNetworkDown = async () => ({ exitCode: 0, stdout: '', stderr: '' });
    const result = await runAuditGate({
      pnpmRun: bothNetworkDown,
      npmRun: bothNetworkDown,
      delayMs: () => 0,
    });
    const verdict = auditVerdict(result);
    check(
      'оба графа недоступны → вердикт FAILED (inconclusive), а не OK',
      verdict.ok === false && verdict.reason === 'inconclusive',
    );
  }

  for (const { name, ok } of checks) console.log(`${ok ? '  ok  ' : ' ОТКАЗ '} ${name}`);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`audit-gate: самопроверка не прошла (${failed.length} из ${checks.length}).`);
    process.exit(1);
  }
  console.log(`audit-gate: самопроверка пройдена, ${checks.length} проверок.`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  if (process.argv.includes('--self-test')) {
    await selfTest();
  } else if (process.argv[2] === 'run') {
    await cliMain();
  } else {
    console.error('использование: node scripts/audit-gate.mjs run | --self-test');
    process.exit(1);
  }
}
