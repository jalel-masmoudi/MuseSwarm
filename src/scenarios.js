/**
 * Judge-scenario presets. Each preset is a multi-file workspace
 * (brief, runbook, domain, isomorphic facade, tests, dark-mode preview, README)
 * plus a one-line Pass 1 fault the verifier/builder loop can diff and heal.
 */

const SPRINT_SLA_CLEAN = 'const slaBreached = elapsedMinutes >= slaMinutes;';
const SPRINT_SLA_BROKEN =
  'const slaBreached = elapsedMinutes >= slaMinutes * 60 * 1000; // pass-1 fault: minutes compared as milliseconds';

const FLAG_CIRCUIT_CLEAN =
  'const shouldRollback = flag.samples >= flag.minSamples && errorRate >= flag.errorThreshold;';
const FLAG_CIRCUIT_BROKEN =
  'const shouldRollback = flag.samples >= flag.minSamples && errorRate < flag.errorThreshold; // pass-1 fault: circuit polarity inverted';

const ONCALL_HANDOFF_CLEAN = 'const local = (utcHour + offset + 48) % 24;';
const ONCALL_HANDOFF_BROKEN =
  'const local = utcHour; // pass-1 fault: timezone offset dropped on handoff';

const AUTHORED_FILES = ['brief.md', 'runbook.md', 'domain.js', 'app.js', 'test.js', 'index.html', 'README.md'];

const DETECTORS = [
  { id: 'feature-flag-rollout', re: /feature flag|canary rollout|canary release|fnv-1a/i },
  { id: 'oncall-fairness-scheduler', re: /on-?call|burnout fairness|fairness scheduler|shift handoff/i },
  { id: 'sprint-priority-engine', re: /priority engine|incident priority|sla breach/i },
];

function previewPage({ title, accent, lead, body, script }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b0f19; color: #e2e8f0; }
    main { max-width: 880px; margin: 0 auto; padding: 28px 18px 64px; }
    h1 { margin: 0 0 6px; font-size: 1.45rem; color: ${accent}; }
    p.lead { color: #94a3b8; margin-top: 0; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; align-items: center; }
    label { font-size: 12px; color: #94a3b8; display: flex; flex-direction: column; gap: 4px; }
    input, select { background: #111827; color: #f8fafc; border: 1px solid #374151; border-radius: 8px; padding: 8px 10px; }
    button { background: ${accent}; color: #0b0f19; border: 0; border-radius: 8px; padding: 8px 14px; font-weight: 700; cursor: pointer; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 12px 14px; margin-top: 10px; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .tag { display: inline-block; margin-left: 8px; padding: 2px 6px; border-radius: 999px; background: rgba(248,113,113,.16); color: #fca5a5; font-size: 12px; }
    .ok { color: #34d399; font-weight: 700; }
    .muted { color: #94a3b8; }
    pre { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 12px; overflow: auto; }
  </style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p class="lead">${lead}</p>
  ${body}
</main>
<script src="domain.js"></script>
<script src="app.js"></script>
<script>
${script}
</script>
</body>
</html>
`;
}

function facade(globalName, members) {
  const fields = members.map((name) => `${name}: domain.${name}`).join(', ');
  return `// Isomorphic facade — Node require('./domain.js') and browser global ${globalName}.
(function (root) {
  const domain = (typeof module !== 'undefined' && module.exports)
    ? require('./domain.js')
    : root.${globalName};
  const api = { ${fields} };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.AppCore = api;
  } else if (root) {
    root.AppCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
}

function buildSprintArtifacts() {
  const domainJs = `// Real-Time Engineering Sprint & Incident Priority domain. Zero npm dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SprintDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function clamp(value, fallback) {
    const n = Number(value);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(1, Math.min(10, base));
  }

  class TaskPriorityEngine {
    constructor() {
      this.items = [];
    }

    addItem(input) {
      const source = input || {};
      const title = source.title;
      if (!title || typeof title !== 'string' || !title.trim()) {
        throw new Error('Title is required');
      }
      const impact = clamp(source.impact, 5);
      const urgency = clamp(source.urgency, 5);
      const effort = clamp(source.effort, 3);
      const slaMinutes = Math.max(1, Number(source.slaMinutes) || 60);
      const elapsedMinutes = Math.max(0, Number(source.elapsedMinutes) || 0);
      ${SPRINT_SLA_CLEAN}
      const slaBoost = slaBreached ? 2.5 : 0;
      const score = Number((((impact * 1.6 + urgency * 1.4) / Math.sqrt(effort)) + slaBoost).toFixed(2));
      const item = {
        id: 'item-' + (this.items.length + 1),
        title: title.trim(),
        impact: impact,
        urgency: urgency,
        effort: effort,
        slaMinutes: slaMinutes,
        elapsedMinutes: elapsedMinutes,
        slaBreached: slaBreached,
        owner: source.owner || '@builder',
        score: score,
        status: 'open',
      };
      this.items.push(item);
      return item;
    }

    getRankedItems() {
      return this.items.slice().sort(function (a, b) {
        return b.score - a.score || a.id.localeCompare(b.id);
      });
    }

    getSlaBreaches() {
      return this.items.filter(function (item) {
        return item.status !== 'done' && item.slaBreached;
      });
    }

    completeItem(id) {
      const found = this.items.find(function (item) { return item.id === id; });
      if (!found) throw new Error('Item not found: ' + id);
      found.status = 'done';
      return found;
    }

    getSummary() {
      const total = this.items.length;
      const done = this.items.filter(function (item) { return item.status === 'done'; }).length;
      const top = this.getRankedItems()[0] || null;
      return {
        total: total,
        done: done,
        open: total - done,
        slaBreaches: this.getSlaBreaches().length,
        topPriority: top ? top.title : null,
      };
    }
  }

  return { TaskPriorityEngine: TaskPriorityEngine };
});
`;

  const testJs = `const assert = require('assert');
const { TaskPriorityEngine } = require('./app.js');

const engine = new TaskPriorityEngine();
const breach = engine.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45, owner: '@builder' });
const polish = engine.addItem({ title: 'Dark-mode polish', impact: 6, urgency: 5, effort: 4, slaMinutes: 120, elapsedMinutes: 20 });
const bus = engine.addItem({ title: 'Session bus backpressure', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 15 });
assert.strictEqual(engine.items.length, 3);
console.log('[PASS] sprint items stored');

assert.strictEqual(breach.slaBreached, true);
assert.strictEqual(polish.slaBreached, false);
assert.strictEqual(engine.getSlaBreaches().length, 1);
console.log('[PASS] SLA breach detector uses elapsed minutes against the SLA');

const ranked = engine.getRankedItems();
assert.strictEqual(ranked[0].id, breach.id);
assert.ok(ranked[0].score > ranked[1].score);
console.log('[PASS] weighted impact/urgency/effort ranking puts the breached incident first');

const calm = new TaskPriorityEngine();
const quiet = calm.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 5 });
assert.strictEqual(quiet.slaBreached, false);
assert.ok(breach.score > quiet.score);
console.log('[PASS] SLA boost raises score only after the minute budget is spent');

engine.completeItem(polish.id);
const summary = engine.getSummary();
assert.strictEqual(summary.done, 1);
assert.strictEqual(summary.open, 2);
assert.strictEqual(summary.slaBreaches, 1);
assert.strictEqual(summary.topPriority, 'Checkout 500s');
console.log('[PASS] summary counts open work separately from completed items');

assert.throws(function () { engine.addItem({ title: '   ' }); }, /Title is required/);
assert.throws(function () { engine.completeItem('missing'); }, /Item not found/);
assert.ok(bus.id);
console.log('[PASS] empty titles and unknown ids are rejected');
`;

  const indexHtml = previewPage({
    title: 'Sprint & Incident Priority',
    accent: '#818cf8',
    lead: 'Score work by impact, urgency, and effort. SLA breaches in minutes float to the top.',
    body: `<div class="row">
    <label>Title <input id="title" placeholder="Incident or task" /></label>
    <label>Impact <input id="impact" type="number" min="1" max="10" value="8" /></label>
    <label>Urgency <input id="urgency" type="number" min="1" max="10" value="8" /></label>
    <label>Effort <input id="effort" type="number" min="1" max="10" value="3" /></label>
    <label>SLA min <input id="sla" type="number" min="1" value="30" /></label>
    <label>Elapsed <input id="elapsed" type="number" min="0" value="45" /></label>
    <button onclick="addItem()">Add to sprint</button>
  </div>
  <div id="list"></div>`,
    script: `var engine = new globalThis.AppCore.TaskPriorityEngine();
engine.addItem({ title: 'Checkout 500s', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45 });
engine.addItem({ title: 'Session bus backpressure', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 10 });
function render() {
  var html = engine.getRankedItems().map(function (item) {
    return '<div class="card"><span>' + item.title + ' <span class="muted">' + item.status + '</span>' +
      (item.slaBreached ? '<span class="tag">SLA BREACH</span>' : '') +
      '</span><span class="ok">Score ' + item.score + '</span></div>';
  }).join('');
  document.getElementById('list').innerHTML = html || '<p class="muted">Queue is empty.</p>';
}
function addItem() {
  var title = document.getElementById('title').value;
  if (!title) return;
  engine.addItem({
    title: title,
    impact: Number(document.getElementById('impact').value),
    urgency: Number(document.getElementById('urgency').value),
    effort: Number(document.getElementById('effort').value),
    slaMinutes: Number(document.getElementById('sla').value),
    elapsedMinutes: Number(document.getElementById('elapsed').value),
  });
  document.getElementById('title').value = '';
  render();
}
render();`,
  });

  const briefMd = `# Brief — Sprint & Incident Priority Engine

## Problem
Engineering leads mix feature work and live incidents in one queue. A single unsorted list hides SLA breaches and over-weights easy tasks.

## Target users
Incident commanders and sprint leads who need a ranked queue during a live shift.

## Core behavior
- Score each item as \`((impact × 1.6) + (urgency × 1.4)) / sqrt(effort)\`.
- When elapsed minutes reach the SLA, add a fixed boost so the breach outranks healthy work of similar size.
- Completing an item drops it out of the breach list without deleting history.

## Files
- \`domain.js\` — \`TaskPriorityEngine\` scoring and SLA rules.
- \`app.js\` — isomorphic facade (\`module.exports\` and \`globalThis.AppCore\`).
- \`test.js\` — Node \`assert\` suite.
- \`index.html\` — dark-mode queue you can extend in the browser.
`;

  const runbookMd = `# Runbook — Sprint & Incident Priority Engine

## Layout
1. \`domain.js\` exports \`TaskPriorityEngine\`.
2. \`app.js\` re-exports it for Node and assigns \`globalThis.AppCore\`.
3. \`index.html\` loads \`domain.js\` then \`app.js\`.
4. \`test.js\` requires \`./app.js\` and prints \`[PASS]\` lines.

## Contract
- \`addItem({ title, impact, urgency, effort, slaMinutes, elapsedMinutes })\` clamps impact/urgency/effort to 1..10.
- \`slaBreached\` is \`elapsedMinutes >= slaMinutes\`. Both values are minutes.
- \`getRankedItems\` sorts by score descending.
- \`getSlaBreaches\` returns open items that have already breached.
- Empty titles and unknown ids throw.

## Do not
- Do not compare minutes to milliseconds.
- Do not add npm dependencies.
`;

  const readmeMd = `# Sprint & Incident Priority Engine

Weighted queue for engineering incidents and sprint work. Built as a MuseSwarm scenario (\`sprint-priority-engine\`).

## Run the tests
\`\`\`bash
node test.js
\`\`\`

## Open the preview
Open \`index.html\` in a browser. \`domain.js\` and \`app.js\` load with no build step.

## Score
\`((impact × 1.6) + (urgency × 1.4)) / sqrt(effort)\`, plus \`2.5\` when elapsed minutes reach the SLA.
`;

  return {
    'brief.md': briefMd,
    'runbook.md': runbookMd,
    'domain.js': domainJs,
    'app.js': facade('SprintDomain', ['TaskPriorityEngine']),
    'test.js': testJs,
    'index.html': indexHtml,
    'README.md': readmeMd,
  };
}

function buildFlagArtifacts() {
  const domainJs = `// Progressive feature-flag and canary controller. Zero npm dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FlagDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fnv1a(text) {
    let hash = 0x811c9dc5;
    const value = String(text);
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  class FeatureFlagController {
    constructor() {
      this.flags = {};
    }

    defineFlag(input) {
      const source = input || {};
      if (!source.key || typeof source.key !== 'string') throw new Error('Flag key is required');
      const flag = {
        key: source.key,
        percentage: Math.max(0, Math.min(100, Number(source.percentage) || 0)),
        errorThreshold: Number.isFinite(Number(source.errorThreshold)) ? Number(source.errorThreshold) : 0.05,
        minSamples: Math.max(1, Number(source.minSamples) || 20),
        samples: 0,
        errors: 0,
        rolledBack: false,
      };
      this.flags[source.key] = flag;
      return flag;
    }

    bucket(key, subjectId) {
      const flag = this._flag(key);
      const hash = fnv1a(key + ':' + subjectId);
      const bucket = hash % 100;
      if (flag.rolledBack || flag.percentage <= 0) {
        return { key: key, subjectId: String(subjectId), hash: hash, bucket: bucket, enrolled: false, rolledBack: flag.rolledBack };
      }
      const percentage = flag.percentage;
      ${'const enrolled = bucket < percentage;'}
      return { key: key, subjectId: String(subjectId), hash: hash, bucket: bucket, enrolled: enrolled, rolledBack: false };
    }

    recordOutcome(key, outcome) {
      const flag = this._flag(key);
      flag.samples += 1;
      if (outcome && outcome.error) flag.errors += 1;
      return this.evaluateCircuit(key);
    }

    evaluateCircuit(key) {
      const flag = this._flag(key);
      const errorRate = flag.samples === 0 ? 0 : flag.errors / flag.samples;
      ${FLAG_CIRCUIT_CLEAN}
      if (shouldRollback) {
        flag.rolledBack = true;
        flag.percentage = 0;
      }
      return {
        key: key,
        samples: flag.samples,
        errors: flag.errors,
        errorRate: Number(errorRate.toFixed(4)),
        rolledBack: flag.rolledBack,
        percentage: flag.percentage,
      };
    }

    _flag(key) {
      const flag = this.flags[key];
      if (!flag) throw new Error('Unknown flag: ' + key);
      return flag;
    }
  }

  return { fnv1a: fnv1a, FeatureFlagController: FeatureFlagController };
});
`;

  const testJs = `const assert = require('assert');
const { fnv1a, FeatureFlagController } = require('./app.js');

assert.strictEqual(fnv1a('muse-spark'), fnv1a('muse-spark'));
assert.notStrictEqual(fnv1a('canary-a'), fnv1a('canary-b'));
console.log('[PASS] FNV-1a hash is deterministic');

const flags = new FeatureFlagController();
flags.defineFlag({ key: 'off', percentage: 0 });
assert.strictEqual(flags.bucket('off', 'user-7').enrolled, false);
flags.defineFlag({ key: 'all', percentage: 100 });
const full = flags.bucket('all', 'user-7');
assert.strictEqual(full.enrolled, true);
assert.strictEqual(full.bucket, fnv1a('all:user-7') % 100);
assert.deepStrictEqual(flags.bucket('all', 'user-7'), full);
console.log('[PASS] percentage bucketing uses hash % 100 and stays stable per subject');

flags.defineFlag({ key: 'pay', percentage: 50, errorThreshold: 0.05, minSamples: 20 });
for (let i = 0; i < 20; i++) flags.recordOutcome('pay', { error: i < 5 });
const tripped = flags.evaluateCircuit('pay');
assert.strictEqual(tripped.rolledBack, true);
assert.strictEqual(tripped.percentage, 0);
assert.strictEqual(flags.bucket('pay', 'user-7').enrolled, false);
console.log('[PASS] canary error rate at or above the threshold rolls the flag back');

const calm = new FeatureFlagController();
calm.defineFlag({ key: 'pay', percentage: 50, errorThreshold: 0.05, minSamples: 20 });
for (let i = 0; i < 20; i++) calm.recordOutcome('pay', { error: false });
assert.strictEqual(calm.evaluateCircuit('pay').rolledBack, false);
console.log('[PASS] healthy canary sample does not trip the breaker');

assert.throws(function () { flags.defineFlag({}); }, /Flag key is required/);
assert.throws(function () { flags.bucket('missing', 'user-1'); }, /Unknown flag/);
console.log('[PASS] missing flag keys are rejected');
`;

  const indexHtml = previewPage({
    title: 'Feature Flag & Canary Rollout',
    accent: '#34d399',
    lead: 'FNV-1a puts each subject in a stable 0–99 bucket. The canary breaker rolls the flag back when the error rate crosses the threshold.',
    body: `<div class="row">
    <label>Flag <input id="flag" value="checkout-v2" /></label>
    <label>Percent <input id="pct" type="number" min="0" max="100" value="25" /></label>
    <label>Subject <input id="subject" value="user-42" /></label>
    <button onclick="defineFlag()">Define</button>
    <button onclick="checkBucket()">Check bucket</button>
    <button onclick="record(false)">Record success</button>
    <button onclick="record(true)">Record error</button>
  </div>
  <pre id="out">Define a flag to begin.</pre>`,
    script: `var ctl = new globalThis.AppCore.FeatureFlagController();
function paint(value) {
  document.getElementById('out').textContent = JSON.stringify(value, null, 2);
}
function defineFlag() {
  paint(ctl.defineFlag({
    key: document.getElementById('flag').value,
    percentage: Number(document.getElementById('pct').value),
    errorThreshold: 0.2,
    minSamples: 5,
  }));
}
function checkBucket() {
  paint(ctl.bucket(document.getElementById('flag').value, document.getElementById('subject').value));
}
function record(isError) {
  paint(ctl.recordOutcome(document.getElementById('flag').value, { error: isError }));
}
defineFlag();
checkBucket();`,
  });

  const briefMd = `# Brief — Feature Flag & Canary Rollout Controller

## Problem
Percentage rollouts that call \`Math.random()\` reshuffle users on every request, and canaries that only page a human still ship a bad build to the rest of the cohort.

## Target users
Backend and frontend owners running a progressive rollout.

## Core behavior
- Bucket \`fnv1a(flag + ':' + subject) % 100\`. A subject is enrolled when \`bucket < percentage\`.
- Record canary outcomes. When samples reach \`minSamples\` and \`errors / samples >= errorThreshold\`, set \`rolledBack\` and force the percentage to 0.

## Files
- \`domain.js\` — hash, controller, circuit breaker.
- \`app.js\` — isomorphic facade.
- \`test.js\` — deterministic hash, enrollment, and rollback assertions.
- \`index.html\` — dark-mode rollout simulator.
`;

  const runbookMd = `# Runbook — Feature Flag & Canary Rollout Controller

## Contract
- \`fnv1a(text)\` returns an unsigned 32-bit FNV-1a hash.
- \`defineFlag({ key, percentage, errorThreshold, minSamples })\` clamps percentage to 0..100.
- \`bucket(key, subjectId)\` is pure for a given flag state. Percentage \`0\` enrolls nobody. Percentage \`100\` enrolls every bucket \`0..99\`.
- \`recordOutcome(key, { error })\` increments samples and, when the rate crosses the threshold, rolls the flag back.
- Rollback uses \`>=\`, so a rate that lands exactly on the threshold trips.

## Do not
- Do not invert the circuit comparison.
- Do not use \`Math.random\` for enrollment.
- Do not add npm dependencies.
`;

  const readmeMd = `# Feature Flag & Canary Rollout Controller

Deterministic percentage rollout plus a canary circuit breaker. MuseSwarm scenario \`feature-flag-rollout\`.

## Run the tests
\`\`\`bash
node test.js
\`\`\`

## Open the simulator
Open \`index.html\`. Define a flag, check a subject bucket, then record successes or errors until the breaker trips.

## Bucketing
\`FNV-1a(flag + ':' + subject) % 100 < percentage\`.
`;

  return {
    'brief.md': briefMd,
    'runbook.md': runbookMd,
    'domain.js': domainJs,
    'app.js': facade('FlagDomain', ['fnv1a', 'FeatureFlagController']),
    'test.js': testJs,
    'index.html': indexHtml,
    'README.md': readmeMd,
  };
}

function buildOnCallArtifacts() {
  const domainJs = `// On-call rotation and burnout fairness scheduler. Zero npm dependencies.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OnCallDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SEVERITY_LOAD = { 1: 5, 2: 3, 3: 1 };

  function timezoneOffsetHours(timezone) {
    const match = /^UTC([+-]\\d{1,2})?$/.exec(String(timezone || 'UTC').trim());
    if (!match) throw new Error('Unsupported timezone: ' + timezone);
    if (!match[1]) return 0;
    return parseInt(match[1], 10);
  }

  function localHour(utcIso, timezone) {
    const utcHour = new Date(utcIso).getUTCHours();
    if (Number.isNaN(utcHour)) throw new Error('Invalid timestamp: ' + utcIso);
    const offset = timezoneOffsetHours(timezone);
    ${ONCALL_HANDOFF_CLEAN}
    return local;
  }

  function jainIndex(loads) {
    const n = loads.length;
    if (!n) return 1;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      sum += loads[i];
      sumSq += loads[i] * loads[i];
    }
    if (sumSq === 0) return 1;
    return Number(((sum * sum) / (n * sumSq)).toFixed(4));
  }

  class OnCallScheduler {
    constructor() {
      this.engineers = [];
      this.shifts = [];
      this.incidents = [];
    }

    addEngineer(input) {
      const source = input || {};
      if (!source.id) throw new Error('Engineer id is required');
      timezoneOffsetHours(source.timezone || 'UTC');
      const engineer = {
        id: source.id,
        name: source.name || source.id,
        timezone: source.timezone || 'UTC',
        weeklyHourCap: Number(source.weeklyHourCap) || 40,
      };
      this.engineers.push(engineer);
      return engineer;
    }

    loadOf(id) {
      return this.incidents.filter(function (item) { return item.engineerId === id; }).reduce(function (acc, item) {
        return acc + (SEVERITY_LOAD[item.severity] || 1);
      }, 0);
    }

    assignShift(input) {
      const source = input || {};
      if (!this.engineers.length) throw new Error('No engineers on the roster');
      const handoffLocalHour = Number.isFinite(Number(source.handoffLocalHour)) ? Number(source.handoffLocalHour) : 9;
      const eligible = this.engineers.filter((engineer) => localHour(source.startUtc, engineer.timezone) === handoffLocalHour);
      const pool = eligible.length ? eligible : this.engineers;
      const ranked = pool.slice().sort((a, b) => this.loadOf(a.id) - this.loadOf(b.id) || a.id.localeCompare(b.id));
      const chosen = ranked[0];
      const shift = {
        id: 'shift-' + (this.shifts.length + 1),
        engineerId: chosen.id,
        startUtc: source.startUtc,
        durationHours: Number(source.durationHours) || 8,
        status: 'open',
        handoffMatched: eligible.length > 0,
      };
      this.shifts.push(shift);
      return shift;
    }

    recordIncident(input) {
      const source = input || {};
      if (!this.engineers.some(function (engineer) { return engineer.id === source.engineerId; })) {
        throw new Error('Unknown engineer: ' + source.engineerId);
      }
      const incident = {
        id: 'inc-' + (this.incidents.length + 1),
        engineerId: source.engineerId,
        severity: Number(source.severity) || 2,
      };
      this.incidents.push(incident);
      return incident;
    }

    fairnessIndex() {
      return jainIndex(this.engineers.map((engineer) => this.loadOf(engineer.id)));
    }

    rebalance() {
      const index = this.fairnessIndex();
      if (index >= 0.85) return { moved: false, fairnessIndex: index };
      const open = this.shifts.filter(function (shift) { return shift.status === 'open'; });
      if (!open.length) return { moved: false, fairnessIndex: index };
      const ranked = this.engineers.slice().sort((a, b) => this.loadOf(b.id) - this.loadOf(a.id) || a.id.localeCompare(b.id));
      const busiest = ranked[0];
      const quietest = ranked[ranked.length - 1];
      if (busiest.id === quietest.id) return { moved: false, fairnessIndex: index };
      const victim = open.find(function (shift) { return shift.engineerId === busiest.id; }) || open[0];
      if (victim.engineerId === quietest.id) return { moved: false, fairnessIndex: index };
      const from = victim.engineerId;
      victim.engineerId = quietest.id;
      victim.rebalanced = true;
      return {
        moved: true,
        shiftId: victim.id,
        from: from,
        to: quietest.id,
        busiest: busiest.id,
        quietest: quietest.id,
        fairnessIndex: this.fairnessIndex(),
      };
    }
  }

  return {
    timezoneOffsetHours: timezoneOffsetHours,
    localHour: localHour,
    jainIndex: jainIndex,
    OnCallScheduler: OnCallScheduler,
  };
});
`;

  const testJs = `const assert = require('assert');
const { OnCallScheduler, localHour, jainIndex } = require('./app.js');

assert.strictEqual(localHour('2026-10-29T01:00:00Z', 'UTC+8'), 9);
assert.strictEqual(localHour('2026-10-29T14:00:00Z', 'UTC-5'), 9);
assert.strictEqual(localHour('2026-10-29T09:00:00Z', 'UTC'), 9);
console.log('[PASS] timezone-aware handoff hour');

const roster = new OnCallScheduler();
roster.addEngineer({ id: 'ada', name: 'Ada', timezone: 'UTC' });
roster.addEngineer({ id: 'bao', name: 'Bao', timezone: 'UTC+8' });
roster.addEngineer({ id: 'chi', name: 'Chi', timezone: 'UTC-5' });

const asia = roster.assignShift({ startUtc: '2026-10-29T01:00:00Z' });
assert.strictEqual(asia.engineerId, 'bao');
assert.strictEqual(asia.handoffMatched, true);
const americas = roster.assignShift({ startUtc: '2026-10-29T14:00:00Z' });
assert.strictEqual(americas.engineerId, 'chi');
const utc = roster.assignShift({ startUtc: '2026-10-29T09:00:00Z' });
assert.strictEqual(utc.engineerId, 'ada');
console.log('[PASS] shift handoff follows the engineer local morning');

const even = new OnCallScheduler();
['ada', 'bao', 'chi'].forEach(function (id) { even.addEngineer({ id: id, timezone: 'UTC' }); });
even.recordIncident({ engineerId: 'ada', severity: 3 });
even.recordIncident({ engineerId: 'bao', severity: 3 });
even.recordIncident({ engineerId: 'chi', severity: 3 });
assert.strictEqual(even.fairnessIndex(), 1);
assert.strictEqual(jainIndex([1, 1, 1]), 1);
assert.strictEqual(even.rebalance().moved, false);
console.log('[PASS] equal incident load keeps Jain fairness at 1');

roster.recordIncident({ engineerId: 'ada', severity: 2 });
roster.recordIncident({ engineerId: 'bao', severity: 1 });
roster.recordIncident({ engineerId: 'bao', severity: 1 });
assert.ok(roster.fairnessIndex() < 0.85);
assert.deepStrictEqual(['ada', 'bao', 'chi'].map(function (id) { return roster.loadOf(id); }), [3, 10, 0]);
const moved = roster.rebalance();
assert.strictEqual(moved.moved, true);
assert.strictEqual(moved.busiest, 'bao', 'highest incident load (bao=10) is the busiest');
assert.strictEqual(moved.quietest, 'chi', 'lowest incident load (chi=0) is the quietest');
assert.strictEqual(moved.from, 'bao');
assert.strictEqual(moved.to, 'chi');
assert.strictEqual(moved.shiftId, asia.id);
assert.strictEqual(asia.engineerId, 'chi');
assert.strictEqual(asia.rebalanced, true);
assert.strictEqual(americas.engineerId, 'chi');
assert.strictEqual(utc.engineerId, 'ada');
assert.strictEqual(roster.shifts.filter(function (s) { return s.engineerId === 'bao'; }).length, 0);
console.log('[PASS] fatigue above the fairness floor moves an open shift');
console.log('[PASS] rebalance moves load from the busiest engineer to the quietest');

assert.throws(function () { roster.addEngineer({ id: 'nope', timezone: 'Mars' }); }, /Unsupported timezone/);
assert.throws(function () { new OnCallScheduler().assignShift({ startUtc: '2026-10-29T09:00:00Z' }); }, /No engineers/);
console.log('[PASS] bad timezones and empty rosters throw');
`;

  const indexHtml = previewPage({
    title: 'On-Call Fairness Scheduler',
    accent: '#fbbf24',
    lead: 'Handoffs use each engineer’s UTC offset. Incident fatigue moves the next open shift when Jain fairness drops below 0.85.',
    body: `<div class="row">
    <label>Id <input id="engId" value="dee" /></label>
    <label>Name <input id="engName" value="Dee" /></label>
    <label>Timezone <input id="engTz" value="UTC+2" /></label>
    <button onclick="addEngineer()">Add engineer</button>
  </div>
  <div class="row">
    <label>Shift start (UTC) <input id="start" value="2026-10-29T09:00:00Z" /></label>
    <button onclick="assignShift()">Assign handoff</button>
    <label>Incident engineer <input id="incEng" value="ada" /></label>
    <label>Severity <select id="sev"><option>1</option><option>2</option><option selected>3</option></select></label>
    <button onclick="recordIncident()">Record incident</button>
    <button onclick="rebalance()">Rebalance</button>
  </div>
  <pre id="out"></pre>`,
    script: `var sched = new globalThis.AppCore.OnCallScheduler();
sched.addEngineer({ id: 'ada', name: 'Ada', timezone: 'UTC' });
sched.addEngineer({ id: 'bao', name: 'Bao', timezone: 'UTC+8' });
sched.addEngineer({ id: 'chi', name: 'Chi', timezone: 'UTC-5' });
function paint(extra) {
  document.getElementById('out').textContent = JSON.stringify({
    fairness: sched.fairnessIndex(),
    engineers: sched.engineers,
    shifts: sched.shifts,
    incidents: sched.incidents,
    extra: extra || null,
  }, null, 2);
}
function addEngineer() {
  sched.addEngineer({
    id: document.getElementById('engId').value,
    name: document.getElementById('engName').value,
    timezone: document.getElementById('engTz').value,
  });
  paint();
}
function assignShift() {
  paint(sched.assignShift({ startUtc: document.getElementById('start').value }));
}
function recordIncident() {
  paint(sched.recordIncident({
    engineerId: document.getElementById('incEng').value,
    severity: Number(document.getElementById('sev').value),
  }));
}
function rebalance() { paint(sched.rebalance()); }
assignShift();`,
  });

  const briefMd = `# Brief — On-Call Rotation & Burnout Fairness Scheduler

## Problem
Follow-the-sun handoffs drift when a scheduler stores local hours as UTC, and the same two people absorb every page.

## Target users
Engineering managers building a weekly rotation across time zones.

## Core behavior
- Convert a UTC shift start into each engineer’s local hour with an explicit \`UTC±N\` offset.
- Assign the handoff (default 09:00 local) to the eligible engineer with the lowest incident load.
- Load is severity-weighted (sev1 = 5, sev2 = 3, sev3 = 1).
- Jain’s fairness index below 0.85 moves one open shift from the busiest engineer toward the quietest.

## Files
- \`domain.js\` — offsets, scheduler, fairness, rebalance.
- \`app.js\` — isomorphic facade.
- \`test.js\` — handoff, fairness, and rebalance assertions.
- \`index.html\` — dark-mode roster.
`;

  const runbookMd = `# Runbook — On-Call Rotation & Burnout Fairness Scheduler

## Contract
- Time zones are \`UTC\`, \`UTC+N\`, or \`UTC-N\` only.
- \`localHour(utcIso, timezone)\` is \`(utcHour + offset + 48) % 24\`.
- \`assignShift({ startUtc, handoffLocalHour })\` prefers engineers whose local hour equals the handoff hour, then the lowest load, then id.
- \`fairnessIndex()\` is Jain’s index over incident loads. Equal non-zero loads score 1. An empty load scores 1.
- \`rebalance()\` is a no-op at or above 0.85. Below that it retargets one open shift.

## Do not
- Do not drop the timezone offset and compare raw UTC hours.
- Do not add npm dependencies.
`;

  const readmeMd = `# On-Call Rotation & Burnout Fairness Scheduler

Timezone-aware handoffs and a Jain fairness rebalance. MuseSwarm scenario \`oncall-fairness-scheduler\`.

## Run the tests
\`\`\`bash
node test.js
\`\`\`

## Open the roster
Open \`index.html\`. Add an engineer, assign a UTC handoff, record an incident, then rebalance.

## Handoff rule
Local hour \`(utcHour + offsetHours + 48) % 24\`. The shift goes to the engineer whose local hour matches the handoff (default 09:00) and who currently carries the least incident weight.
`;

  return {
    'brief.md': briefMd,
    'runbook.md': runbookMd,
    'domain.js': domainJs,
    'app.js': facade('OnCallDomain', ['timezoneOffsetHours', 'localHour', 'jainIndex', 'OnCallScheduler']),
    'test.js': testJs,
    'index.html': indexHtml,
    'README.md': readmeMd,
  };
}

const SCENARIO_PRESETS = [
  {
    id: 'sprint-priority-engine',
    title: 'Real-Time Engineering Sprint & Incident Priority Engine',
    tagline: 'Weighted impact, urgency, and effort scoring with a minute-based SLA breach detector.',
    prompt:
      'Build a Real-Time Engineering Sprint & Incident Priority Engine with weighted impact/urgency/effort scoring, an SLA breach detector, and a multi-file workspace (domain.js, app.js, test.js, index.html).',
    projectName: 'sprint-priority-engine',
    highlights: [
      'Impact × 1.6 + urgency × 1.4, divided by sqrt(effort)',
      'SLA breach detector in minutes, with a score boost',
      'domain.js core plus isomorphic app.js facade',
    ],
    pass1Fault: {
      file: 'domain.js',
      summary: 'SLA check multiplies the minute budget by 3,600,000, so a real breach never fires (minutes compared as milliseconds).',
      find: SPRINT_SLA_CLEAN,
      replace: SPRINT_SLA_BROKEN,
    },
    buildArtifacts: buildSprintArtifacts,
  },
  {
    id: 'feature-flag-rollout',
    title: 'Progressive Feature Flag & Canary Rollout Controller',
    tagline: 'Deterministic FNV-1a percentage bucketing and a canary error-rate circuit breaker that auto-rolls back.',
    prompt:
      'Build a Progressive Feature Flag & Canary Rollout Controller with deterministic FNV-1a percentage bucketing, a canary error-rate circuit breaker, and auto-rollback.',
    projectName: 'feature-flag-rollout',
    highlights: [
      'FNV-1a hash % 100 enrollment',
      'Canary circuit breaker with auto-rollback',
      'Interactive rollout simulator',
    ],
    pass1Fault: {
      file: 'domain.js',
      summary: 'Circuit breaker compares error rate with < instead of >=, so a hot canary never rolls back and a healthy one can.',
      find: FLAG_CIRCUIT_CLEAN,
      replace: FLAG_CIRCUIT_BROKEN,
    },
    buildArtifacts: buildFlagArtifacts,
  },
  {
    id: 'oncall-fairness-scheduler',
    title: 'On-Call Rotation & Burnout Fairness Scheduler',
    tagline: 'Timezone-aware shift handoffs, a Jain fairness index, and incident-fatigue auto-rebalance.',
    prompt:
      'Build an On-Call Rotation & Burnout Fairness Scheduler with timezone-aware shift handoffs, a load-balance fairness index, and incident-fatigue auto-rebalance.',
    projectName: 'oncall-fairness-scheduler',
    highlights: [
      'UTC offset handoffs',
      'Jain fairness index over severity-weighted load',
      'Auto-rebalance of an open shift under fatigue',
    ],
    pass1Fault: {
      file: 'domain.js',
      summary: 'Handoff uses the raw UTC hour and drops the engineer timezone offset, so follow-the-sun shifts land on the wrong person.',
      find: ONCALL_HANDOFF_CLEAN,
      replace: ONCALL_HANDOFF_BROKEN,
    },
    buildArtifacts: buildOnCallArtifacts,
  },
];

function getScenario(scenarioId) {
  if (!scenarioId) return null;
  return SCENARIO_PRESETS.find((preset) => preset.id === scenarioId) || null;
}

function resolveScenarioId(scenarioId, prompt) {
  if (getScenario(scenarioId)) return scenarioId;
  const text = String(prompt || '');
  for (const detector of DETECTORS) {
    if (detector.re.test(text)) return detector.id;
  }
  return null;
}

function buildScenarioArtifacts(scenarioId) {
  const preset = getScenario(scenarioId);
  if (!preset) return null;
  return preset.buildArtifacts();
}

// Live-seen bug: sort ascending (quietest first) but still treat ranked[0] as busiest,
// which inverts rebalance. The fixture tests pin the real direction so this cannot pass.
function applyOnCallAscendingBusiestFault(domainJs) {
  const needle = 'this.engineers.slice().sort((a, b) => this.loadOf(b.id) - this.loadOf(a.id)';
  if (typeof domainJs !== 'string' || !domainJs.includes(needle)) {
    throw new Error('oncall rebalance sort anchor missing');
  }
  return domainJs.replace(needle, 'this.engineers.slice().sort((a, b) => this.loadOf(a.id) - this.loadOf(b.id)');
}

function applyPass1Fault(artifacts, scenarioId) {
  const preset = getScenario(scenarioId);
  if (!preset) return null;
  const fault = preset.pass1Fault;
  const source = artifacts && artifacts[fault.file];
  if (typeof source !== 'string' || !source.includes(fault.find)) {
    throw new Error('Pass-1 fault anchor missing in ' + fault.file + ' for ' + preset.id);
  }
  return {
    file: fault.file,
    clean: source,
    broken: source.replace(fault.find, fault.replace),
  };
}

function serializeScenarios() {
  return SCENARIO_PRESETS.map((preset) => ({
    id: preset.id,
    title: preset.title,
    tagline: preset.tagline,
    prompt: preset.prompt,
    projectName: preset.projectName,
    highlights: preset.highlights,
    files: AUTHORED_FILES.concat(['benchmark.json']),
    pass1Fault: {
      file: preset.pass1Fault.file,
      summary: preset.pass1Fault.summary,
    },
    artifacts: preset.buildArtifacts(),
  }));
}

module.exports = {
  SCENARIO_PRESETS,
  AUTHORED_FILES,
  getScenario,
  resolveScenarioId,
  buildScenarioArtifacts,
  applyPass1Fault,
  applyOnCallAscendingBusiestFault,
  serializeScenarios,
};
