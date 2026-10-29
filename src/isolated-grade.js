'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ANY_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function scenarioAppLoadsDomain(content) {
  return /require\s*\(\s*['"]\.\/domain(?:\.js)?['"]\s*\)/.test(String(content || ''));
}

function stripJsComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function scanModelFaultSource(source, allowedLocals = ['domain.js']) {
  const reasons = [];
  const text = String(source || '');
  const code = stripJsComments(text);
  if (/\brequire\s*\(\s*['"](?:node:)?assert['"]\s*\)/.test(code) || /\bassert\s*\./.test(code) || /\bassert\s*\[/.test(code)) {
    reasons.push('assert');
  }
  if (/\brequire\.cache\b/.test(code)) reasons.push('require.cache');
  if (/\bprocess\b/.test(code)) reasons.push('process');
  if (/\bModule\b/.test(code) || /\brequire\s*\(\s*['"](?:node:)?module['"]\s*\)/.test(code)) reasons.push('Module');
  if (
    /\b(?:globalThis|global)\s*\.\s*(assert|require|process|module|Module|Function|Object|Promise|Buffer|eval)\s*=/.test(code) ||
    /\b(?:globalThis|global)\s*\[\s*['"](?:assert|require|process|module|Module)['"]\s*\]\s*=/.test(code) ||
    /\bObject\.(?:assign|defineProperty|defineProperties)\s*\(\s*(?:globalThis|global)\b/.test(code)
  ) {
    reasons.push('global_patch');
  }
  const allowed = new Set(
    (allowedLocals || []).map((p) => String(p).replace(/^\.\//, '').replace(/\\/g, '/')).flatMap((p) => (p.endsWith('.js') ? [p, p.slice(0, -3)] : [p, `${p}.js`]))
  );
  let m;
  ANY_REQUIRE.lastIndex = 0;
  while ((m = ANY_REQUIRE.exec(code))) {
    const spec = m[1];
    if (spec === 'assert' || spec === 'node:assert') continue;
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const base = spec.replace(/^\.\//, '').replace(/\\/g, '/');
      const normalized = base.endsWith('.js') ? base : `${base}.js`;
      if (!allowed.has(base) && !allowed.has(normalized)) reasons.push(`require(${spec})`);
    } else {
      reasons.push(`require(${spec})`);
    }
  }
  return [...new Set(reasons)];
}

function wrapRunner(body) {
  return `'use strict';
const fs = require('fs');
const path = require('path');
function catchErr(fn) {
  try { fn(); return null; } catch (e) { return String(e && e.message || e); }
}
let domain;
try {
  domain = require('./domain.js');
} catch (e) {
  fs.writeFileSync(path.join(__dirname, 'grade.json'), JSON.stringify({ __gradeError: String(e && e.stack || e) }));
  process.exit(2);
}
try {
  const out = (function () {
${body}
  })();
  fs.writeFileSync(path.join(__dirname, 'grade.json'), JSON.stringify(out));
} catch (e) {
  fs.writeFileSync(path.join(__dirname, 'grade.json'), JSON.stringify({ __gradeError: String(e && e.stack || e) }));
  process.exit(3);
}
`;
}

const GRADE_BODIES = {
  'sprint-priority-engine': `
    const { TaskPriorityEngine } = domain;
    const engine = new TaskPriorityEngine();
    const breach = engine.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45, owner: '@builder' });
    const polish = engine.addItem({ title: 'Dark-mode polish', impact: 6, urgency: 5, effort: 4, slaMinutes: 120, elapsedMinutes: 20 });
    const bus = engine.addItem({ title: 'Session bus backpressure', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 15 });
    const ranked = engine.getRankedItems();
    const calm = new TaskPriorityEngine();
    const quiet = calm.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 5 });
    engine.completeItem(polish.id);
    const summary = engine.getSummary();
    return {
      itemsLength: engine.items.length,
      breachSla: breach.slaBreached,
      polishSla: polish.slaBreached,
      breachCount: engine.getSlaBreaches().length,
      topId: ranked[0] && ranked[0].id,
      rankedOrder: Boolean(ranked[0] && ranked[1] && ranked[0].score > ranked[1].score),
      quietSla: quiet.slaBreached,
      slaBoost: breach.score > quiet.score,
      summaryDone: summary.done,
      summaryOpen: summary.open,
      summarySla: summary.slaBreaches,
      summaryTop: summary.topPriority,
      emptyTitle: catchErr(function () { engine.addItem({ title: '   ' }); }),
      missingId: catchErr(function () { engine.completeItem('missing'); }),
      busId: Boolean(bus.id),
    };
  `,
  'feature-flag-rollout': `
    const { fnv1a, FeatureFlagController } = domain;
    const flags = new FeatureFlagController();
    flags.defineFlag({ key: 'off', percentage: 0 });
    flags.defineFlag({ key: 'all', percentage: 100 });
    const full = flags.bucket('all', 'user-7');
    flags.defineFlag({ key: 'pay', percentage: 50, errorThreshold: 0.05, minSamples: 20 });
    for (let i = 0; i < 20; i++) flags.recordOutcome('pay', { error: i < 5 });
    const tripped = flags.evaluateCircuit('pay');
    const calm = new FeatureFlagController();
    calm.defineFlag({ key: 'pay', percentage: 50, errorThreshold: 0.05, minSamples: 20 });
    for (let i = 0; i < 20; i++) calm.recordOutcome('pay', { error: false });
    return {
      hashStable: fnv1a('muse-spark') === fnv1a('muse-spark'),
      hashDiff: fnv1a('canary-a') !== fnv1a('canary-b'),
      offEnrolled: flags.bucket('off', 'user-7').enrolled,
      allEnrolled: full.enrolled,
      allBucket: full.bucket,
      allStable: JSON.stringify(flags.bucket('all', 'user-7')) === JSON.stringify(full),
      trippedBack: tripped.rolledBack,
      trippedPct: tripped.percentage,
      payAfterTrip: flags.bucket('pay', 'user-7').enrolled,
      calmBack: calm.evaluateCircuit('pay').rolledBack,
      missingKey: catchErr(function () { flags.defineFlag({}); }),
      unknownFlag: catchErr(function () { flags.bucket('missing', 'user-1'); }),
    };
  `,
  'oncall-fairness-scheduler': `
    const { OnCallScheduler, localHour, jainIndex } = domain;
    const roster = new OnCallScheduler();
    roster.addEngineer({ id: 'ada', name: 'Ada', timezone: 'UTC' });
    roster.addEngineer({ id: 'bao', name: 'Bao', timezone: 'UTC+8' });
    roster.addEngineer({ id: 'chi', name: 'Chi', timezone: 'UTC-5' });
    const asia = roster.assignShift({ startUtc: '2026-10-29T01:00:00Z' });
    const americas = roster.assignShift({ startUtc: '2026-10-29T14:00:00Z' });
    const utc = roster.assignShift({ startUtc: '2026-10-29T09:00:00Z' });
    const even = new OnCallScheduler();
    ['ada', 'bao', 'chi'].forEach(function (id) { even.addEngineer({ id: id, timezone: 'UTC' }); });
    even.recordIncident({ engineerId: 'ada', severity: 3 });
    even.recordIncident({ engineerId: 'bao', severity: 3 });
    even.recordIncident({ engineerId: 'chi', severity: 3 });
    roster.recordIncident({ engineerId: 'ada', severity: 2 });
    roster.recordIncident({ engineerId: 'bao', severity: 1 });
    roster.recordIncident({ engineerId: 'bao', severity: 1 });
    const loads = ['ada', 'bao', 'chi'].map(function (id) { return roster.loadOf(id); });
    const moved = roster.rebalance();
    return {
      hourUtc8: localHour('2026-10-29T01:00:00Z', 'UTC+8'),
      hourUtcM5: localHour('2026-10-29T14:00:00Z', 'UTC-5'),
      hourUtc: localHour('2026-10-29T09:00:00Z', 'UTC'),
      asiaId: asia.engineerId,
      asiaMatch: asia.handoffMatched,
      americasId: americas.engineerId,
      utcId: utc.engineerId,
      evenFair: even.fairnessIndex(),
      jainOnes: jainIndex([1, 1, 1]),
      evenMoved: even.rebalance().moved,
      loads: loads,
      fairnessLow: roster.fairnessIndex() < 0.85,
      moved: moved.moved,
      busiest: moved.busiest,
      quietest: moved.quietest,
      from: moved.from,
      to: moved.to,
      shiftId: moved.shiftId,
      asiaAfter: asia.engineerId,
      asiaRebalanced: asia.rebalanced,
      americasAfter: americas.engineerId,
      utcAfter: utc.engineerId,
      baoShifts: roster.shifts.filter(function (s) { return s.engineerId === 'bao'; }).length,
      badTz: catchErr(function () { roster.addEngineer({ id: 'nope', timezone: 'Mars' }); }),
      emptyRoster: catchErr(function () { new OnCallScheduler().assignShift({ startUtc: '2026-10-29T09:00:00Z' }); }),
    };
  `,
};

function runDomainGradeChild(scenarioId, domainSource) {
  const body = GRADE_BODIES[scenarioId];
  if (!body) return { ok: false, error: 'no grade runner for ' + scenarioId };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'museswarm-iso-'));
  try {
    fs.writeFileSync(path.join(tmp, 'domain.js'), String(domainSource || ''), 'utf8');
    fs.writeFileSync(path.join(tmp, 'grade-runner.js'), wrapRunner(body), 'utf8');
    const result = spawnSync(process.execPath, ['--no-warnings', 'grade-runner.js'], {
      cwd: tmp,
      timeout: 8000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        HOME: tmp,
        TMPDIR: tmp,
        NO_COLOR: '1',
      },
    });
    const jsonPath = path.join(tmp, 'grade.json');
    let value = null;
    if (fs.existsSync(jsonPath)) {
      try {
        value = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (err) {
        return { ok: false, error: 'grade.json parse failed: ' + err.message, stdout: result.stdout, stderr: result.stderr };
      }
    }
    if (result.error || result.status !== 0 || !value || value.__gradeError) {
      return {
        ok: false,
        error: (value && value.__gradeError) || String((result.stderr || '').trim() || result.error || 'grade child failed'),
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    return { ok: true, value };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const expectedCache = new Map();

function expectedGrade(scenarioId, fixtureDomain) {
  const key = scenarioId + ':' + String(fixtureDomain || '').length;
  if (expectedCache.has(key)) return expectedCache.get(key);
  const got = runDomainGradeChild(scenarioId, fixtureDomain);
  expectedCache.set(key, got);
  return got;
}

function valuesEqual(a, b) {
  try {
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function runIsolatedDomainGrade(scenarioId, modelDomain, fixtureDomain, allowedLocals) {
  const scan = scanModelFaultSource(modelDomain, allowedLocals);
  if (scan.length) {
    return { passed: false, reason: 'static:' + scan.join(','), scan };
  }
  const expected = expectedGrade(scenarioId, fixtureDomain);
  const actual = runDomainGradeChild(scenarioId, modelDomain);
  if (!expected.ok) return { passed: false, reason: 'fixture_grade_failed', detail: expected.error, scan };
  if (!actual.ok) return { passed: false, reason: 'model_grade_failed', detail: actual.error, scan };
  const passed = valuesEqual(expected.value, actual.value);
  return {
    passed,
    reason: passed ? 'match' : 'mismatch',
    scan,
    expected: expected.value,
    actual: actual.value,
  };
}

module.exports = {
  scenarioAppLoadsDomain,
  scanModelFaultSource,
  runDomainGradeChild,
  runIsolatedDomainGrade,
};
