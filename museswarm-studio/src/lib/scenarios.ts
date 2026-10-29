import type { AgentId, AgentState, Message, Task, TaskStatus } from "./swarm-data.ts";

export type Check = { name: string; ok: boolean };

export type Scenario = {
  id: string;
  title: string;
  kicker: string;
  description: string;
  brief: string;
  expectsRework: boolean;
  files: Record<string, string>;
  pass1?: Record<string, string>;
  messages: Message[];
  tasks: Task[];
  failChecks?: Check[];
  passChecks: Check[];
  failStdout?: string;
  passStdout: string;
  failScore?: number;
  score: number;
};

export type PlaybackStep = {
  delay: number;
  agents?: Partial<Record<AgentId, AgentState>>;
  msg?: Message;
  tasks?: Record<string, { status?: TaskStatus; note?: string }>;
  checks?: Check[];
  score?: number;
  files?: Record<string, string>;
  phase?: "pass1" | "pass2";
};

const SOL_P1 = `"use strict";

let stock = 1;
let seq = 0;

function reset(next) {
  stock = next == null ? 1 : next;
  seq = 0;
}

function settleConcurrent(reserves) {
  const seen = stock;
  const accepted = [];
  let left = seen;
  for (const r of reserves) {
    // Lost update: every attempt in the burst reads the pre-loop stock.
    if (seen >= r.qty) {
      accepted.push(r.id);
      left -= r.qty;
    }
  }
  stock = left;
  seq += 1;
  return { accepted: accepted, stock: stock, seq: seq };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { reset: reset, settleConcurrent: settleConcurrent };
}
`;

const SOL_P2 = `"use strict";

let stock = 1;
let seq = 0;

function reset(next) {
  stock = next == null ? 1 : next;
  seq = 0;
}

function settleConcurrent(reserves) {
  const seen = stock;
  const accepted = [];
  let left = seen;
  for (const r of reserves) {
    // Remaining stock, not the pre-loop snapshot — concurrent acquires serialize.
    if (left >= r.qty) {
      accepted.push(r.id);
      left -= r.qty;
    }
  }
  stock = left;
  seq += 1;
  return { accepted: accepted, stock: stock, seq: seq };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { reset: reset, settleConcurrent: settleConcurrent };
}
`;

const TEST_P1 = `"use strict";
const assert = require("assert");
const { reset, settleConcurrent } = require("./solution.js");

reset(3);
const wide = settleConcurrent([
  { id: "a", qty: 1 },
  { id: "b", qty: 1 },
]);
assert.deepStrictEqual(wide.accepted, ["a", "b"]);
assert.strictEqual(wide.stock, 1);

reset(1);
const race = settleConcurrent([
  { id: "a", qty: 1 },
  { id: "b", qty: 1 },
]);
assert.deepStrictEqual(race.accepted, ["a"], "last unit is exclusive");
assert.strictEqual(race.stock, 0);
assert.strictEqual(race.seq, 1);

console.log("[PASS] capacity allows both");
console.log("[PASS] exclusive last unit");
console.log("ALL TESTS PASSED (2/2)");
`;

const TEST_P2 = `"use strict";
const assert = require("assert");
const { reset, settleConcurrent } = require("./solution.js");

reset(3);
const wide = settleConcurrent([
  { id: "a", qty: 1 },
  { id: "b", qty: 1 },
]);
assert.deepStrictEqual(wide.accepted, ["a", "b"]);
assert.strictEqual(wide.stock, 1);

reset(1);
const race = settleConcurrent([
  { id: "a", qty: 1 },
  { id: "b", qty: 1 },
]);
assert.deepStrictEqual(race.accepted, ["a"], "last unit is exclusive");
assert.strictEqual(race.stock, 0);
assert.strictEqual(race.seq, 1);

// Regression: empty burst must not move stock or look like a race winner.
reset(1);
const none = settleConcurrent([]);
assert.deepStrictEqual(none.accepted, []);
assert.strictEqual(none.stock, 1);
assert.strictEqual(none.seq, 1);

console.log("[PASS] capacity allows both");
console.log("[PASS] exclusive last unit");
console.log("[PASS] empty burst is a no-op");
console.log("ALL TESTS PASSED (3/3)");
`;

const HEAL_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Last-unit reservation</title>
<style>
  body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;background:#000;color:#f5f5f7;padding:24px}
  button{background:#0a84ff;color:#fff;border:0;border-radius:999px;padding:8px 14px;font-weight:600;cursor:pointer}
  pre{background:#1c1c1e;border-radius:12px;padding:12px;min-height:72px}
  p{color:#a1a1a6}
</style>
</head>
<body>
  <h1>Last-unit reservation</h1>
  <p>Two same-tick acquires of the final unit. After the self-heal, only one id is accepted.</p>
  <button id="go">Fire burst</button>
  <pre id="out">press the button</pre>
  <script src="app.js"></script>
  <script>
    document.getElementById("go").onclick = function () {
      reset(1);
      var r = settleConcurrent([{ id: "a", qty: 1 }, { id: "b", qty: 1 }]);
      document.getElementById("out").textContent = JSON.stringify(r, null, 2);
    };
  </script>
</body>
</html>
`;

const BUCKET_JS = `"use strict";

function createBucket(opts) {
  const capacity = opts && opts.capacity != null ? opts.capacity : 10;
  const refillPerSec = opts && opts.refillPerSec != null ? opts.refillPerSec : 5;
  let tokens = capacity;
  let updatedAt = 0;
  return {
    tryAcquire: function (n, now) {
      const count = n == null ? 1 : n;
      const t = now == null ? 0 : now;
      const elapsedSec = Math.max(0, t - updatedAt) / 1000;
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      updatedAt = t;
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
  };
}

module.exports = { createBucket: createBucket };
`;

const BREAKER_JS = `"use strict";

function createBreaker(opts) {
  const threshold = opts && opts.threshold != null ? opts.threshold : 3;
  const resetMs = opts && opts.resetMs != null ? opts.resetMs : 1000;
  let failures = 0;
  let openedAt = null;
  return {
    state: function (now) {
      const t = now == null ? 0 : now;
      if (openedAt != null && t - openedAt >= resetMs) return "half-open";
      if (openedAt != null) return "open";
      return "closed";
    },
    allow: function (now) {
      return this.state(now) !== "open";
    },
    record: function (ok, now) {
      const t = now == null ? 0 : now;
      if (ok) {
        failures = 0;
        openedAt = null;
        return "closed";
      }
      failures += 1;
      if (failures >= threshold) openedAt = t;
      return this.state(t);
    },
  };
}

module.exports = { createBreaker: createBreaker };
`;

const GUARD_JS = `"use strict";

const { createBucket } = require("./token-bucket.js");
const { createBreaker } = require("./circuit-breaker.js");

function createGuard(opts) {
  const bucket = createBucket(opts && opts.bucket);
  const breaker = createBreaker(opts && opts.breaker);
  return {
    enter: function (now) {
      if (!breaker.allow(now)) return { ok: false, reason: "open" };
      if (!bucket.tryAcquire(1, now)) return { ok: false, reason: "throttled" };
      return { ok: true };
    },
    report: function (ok, now) {
      return breaker.record(ok, now);
    },
  };
}

module.exports = { createGuard: createGuard };
`;

const GUARD_BROWSER = `"use strict";

function createBucket(opts) {
  const capacity = opts && opts.capacity != null ? opts.capacity : 10;
  const refillPerSec = opts && opts.refillPerSec != null ? opts.refillPerSec : 5;
  let tokens = capacity;
  let updatedAt = 0;
  return {
    tryAcquire: function (n, now) {
      const count = n == null ? 1 : n;
      const t = now == null ? 0 : now;
      const elapsedSec = Math.max(0, t - updatedAt) / 1000;
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      updatedAt = t;
      if (tokens < count) return false;
      tokens -= count;
      return true;
    },
  };
}

function createBreaker(opts) {
  const threshold = opts && opts.threshold != null ? opts.threshold : 3;
  const resetMs = opts && opts.resetMs != null ? opts.resetMs : 1000;
  let failures = 0;
  let openedAt = null;
  return {
    state: function (now) {
      const t = now == null ? 0 : now;
      if (openedAt != null && t - openedAt >= resetMs) return "half-open";
      if (openedAt != null) return "open";
      return "closed";
    },
    allow: function (now) {
      return this.state(now) !== "open";
    },
    record: function (ok, now) {
      const t = now == null ? 0 : now;
      if (ok) {
        failures = 0;
        openedAt = null;
        return "closed";
      }
      failures += 1;
      if (failures >= threshold) openedAt = t;
      return this.state(t);
    },
  };
}

function createGuard(opts) {
  const bucket = createBucket(opts && opts.bucket);
  const breaker = createBreaker(opts && opts.breaker);
  return {
    enter: function (now) {
      if (!breaker.allow(now)) return { ok: false, reason: "open" };
      if (!bucket.tryAcquire(1, now)) return { ok: false, reason: "throttled" };
      return { ok: true };
    },
    report: function (ok, now) {
      return breaker.record(ok, now);
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createBucket: createBucket, createBreaker: createBreaker, createGuard: createGuard };
}
`;

const GUARD_TEST = `"use strict";
const assert = require("assert");
const { createBucket } = require("./token-bucket.js");
const { createBreaker } = require("./circuit-breaker.js");
const { createGuard } = require("./solution.js");

const bucket = createBucket({ capacity: 2, refillPerSec: 10 });
assert.strictEqual(bucket.tryAcquire(1, 0), true);
assert.strictEqual(bucket.tryAcquire(1, 0), true);
assert.strictEqual(bucket.tryAcquire(1, 0), false);
assert.strictEqual(bucket.tryAcquire(1, 1000), true);

const breaker = createBreaker({ threshold: 2, resetMs: 1000 });
assert.strictEqual(breaker.allow(0), true);
assert.strictEqual(breaker.record(false, 0), "closed");
assert.strictEqual(breaker.record(false, 10), "open");
assert.strictEqual(breaker.allow(10), false);
assert.strictEqual(breaker.state(1010), "half-open");
assert.strictEqual(breaker.allow(1010), true);
assert.strictEqual(breaker.record(true, 1010), "closed");

const guard = createGuard({
  bucket: { capacity: 1, refillPerSec: 0 },
  breaker: { threshold: 2, resetMs: 5000 },
});
assert.deepStrictEqual(guard.enter(0), { ok: true });
assert.deepStrictEqual(guard.enter(0), { ok: false, reason: "throttled" });
assert.strictEqual(guard.report(false, 0), "closed");
assert.strictEqual(guard.report(false, 1), "open");
assert.deepStrictEqual(guard.enter(2), { ok: false, reason: "open" });

console.log("[PASS] token bucket");
console.log("[PASS] circuit breaker");
console.log("[PASS] guard composition");
console.log("ALL TESTS PASSED (3/3)");
`;

const GUARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Token bucket & circuit breaker</title>
<style>
  body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;background:#000;color:#f5f5f7;padding:24px}
  button{background:#30d158;color:#04140a;border:0;border-radius:999px;padding:8px 14px;font-weight:600;cursor:pointer}
  pre{background:#1c1c1e;border-radius:12px;padding:12px}
  p{color:#a1a1a6}
</style>
</head>
<body>
  <h1>Guard</h1>
  <p>Capacity 2, then three failures open the breaker.</p>
  <button id="go">Exercise guard</button>
  <pre id="out">press the button</pre>
  <script src="app.js"></script>
  <script>
    document.getElementById("go").onclick = function () {
      var g = createGuard({ bucket: { capacity: 2, refillPerSec: 0 }, breaker: { threshold: 3, resetMs: 5000 } });
      var lines = [];
      lines.push("enter " + JSON.stringify(g.enter(0)));
      lines.push("enter " + JSON.stringify(g.enter(0)));
      lines.push("enter " + JSON.stringify(g.enter(0)));
      lines.push("fail " + g.report(false, 1));
      lines.push("fail " + g.report(false, 2));
      lines.push("fail " + g.report(false, 3));
      lines.push("enter " + JSON.stringify(g.enter(4)));
      document.getElementById("out").textContent = lines.join("\\n");
    };
  </script>
</body>
</html>
`;

const DAG_JS = `"use strict";

function score(t) {
  var s = t.impact * 0.5 + t.urgency * 0.35 + (10 - t.effort) * 0.15;
  return Math.round(s * 10) / 10;
}

function slaBreached(t, now) {
  var clock = now == null ? 0 : now;
  return t.slaHours != null && clock - t.openedAt > t.slaHours * 3600e3;
}

function rank(items, now) {
  return items
    .map(function (t) {
      return Object.assign({}, t, { score: score(t), breached: slaBreached(t, now) });
    })
    .sort(function (a, b) {
      return (b.breached - a.breached) || (b.score - a.score);
    });
}

function topoRank(tasks) {
  var ids = tasks.map(function (t) { return t.id; });
  var indeg = new Map(ids.map(function (id) { return [id, 0]; }));
  var adj = new Map(ids.map(function (id) { return [id, []]; }));
  for (var i = 0; i < tasks.length; i++) {
    var deps = tasks[i].dependsOn || [];
    for (var j = 0; j < deps.length; j++) {
      var edge = adj.get(deps[j]);
      if (!edge) throw new Error("missing dependency " + deps[j]);
      edge.push(tasks[i].id);
      indeg.set(tasks[i].id, indeg.get(tasks[i].id) + 1);
    }
  }
  var q = ids.filter(function (id) { return indeg.get(id) === 0; });
  var order = [];
  while (q.length) {
    var id = q.shift();
    order.push(id);
    var next = adj.get(id);
    for (var k = 0; k < next.length; k++) {
      indeg.set(next[k], indeg.get(next[k]) - 1);
      if (indeg.get(next[k]) === 0) q.push(next[k]);
    }
  }
  if (order.length !== tasks.length) throw new Error("cycle detected in sprint DAG");
  var byId = {};
  for (var n = 0; n < tasks.length; n++) byId[tasks[n].id] = tasks[n];
  var dist = {};
  var prev = {};
  for (var o = 0; o < order.length; o++) {
    var cur = order[o];
    var best = 0;
    var from = null;
    var parents = byId[cur].dependsOn || [];
    for (var p = 0; p < parents.length; p++) {
      var cand = dist[parents[p]] || 0;
      if (cand >= best) {
        best = cand;
        from = parents[p];
      }
    }
    dist[cur] = best + (byId[cur].duration || 1);
    prev[cur] = from;
  }
  var end = order[0];
  for (var e = 0; e < order.length; e++) if (dist[order[e]] > dist[end]) end = order[e];
  var path = [];
  for (var c = end; c; c = prev[c]) path.push(c);
  path.reverse();
  return { order: order, criticalPath: path, length: dist[end] };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { score: score, slaBreached: slaBreached, rank: rank, topoRank: topoRank };
}
`;

const DAG_TEST = `"use strict";
const assert = require("assert");
const { score, slaBreached, rank, topoRank } = require("./solution.js");

assert.strictEqual(score({ impact: 10, urgency: 10, effort: 0 }), 10);
assert.strictEqual(score({ impact: 0, urgency: 0, effort: 10 }), 0);
assert.strictEqual(slaBreached({ slaHours: 1, openedAt: 0 }, 7200e3), true);
assert.strictEqual(slaBreached({ slaHours: 4, openedAt: 0 }, 3600e3), false);

const ranked = rank([
  { id: "a", impact: 2, urgency: 2, effort: 5 },
  { id: "b", impact: 9, urgency: 8, effort: 3, slaHours: 1, openedAt: 0 },
], 7200e3);
assert.strictEqual(ranked[0].id, "b");
assert.strictEqual(ranked[0].breached, true);

const dag = topoRank([
  { id: "spec", duration: 2, dependsOn: [] },
  { id: "build", duration: 5, dependsOn: ["spec"] },
  { id: "qa", duration: 3, dependsOn: ["build"] },
  { id: "docs", duration: 1, dependsOn: ["spec"] },
]);
assert.strictEqual(dag.order[0], "spec");
assert.ok(dag.order.indexOf("build") < dag.order.indexOf("qa"));
assert.deepStrictEqual(dag.criticalPath, ["spec", "build", "qa"]);
assert.strictEqual(dag.length, 10);

assert.throws(function () {
  topoRank([
    { id: "a", duration: 1, dependsOn: ["b"] },
    { id: "b", duration: 1, dependsOn: ["a"] },
  ]);
}, /cycle/);

console.log("[PASS] score bounds");
console.log("[PASS] sla breach");
console.log("[PASS] rank");
console.log("[PASS] critical path");
console.log("[PASS] cycle detection");
console.log("ALL TESTS PASSED (5/5)");
`;

const DAG_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sprint DAG</title>
<style>
  body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;background:#000;color:#f5f5f7;padding:24px}
  .row{display:flex;justify-content:space-between;background:#1c1c1e;border-radius:12px;padding:10px 12px;margin:6px 0}
  .bad{color:#ff453a;font-size:12px;margin-left:8px}
  code{color:#64d2ff}
</style>
</head>
<body>
  <h1>Sprint DAG</h1>
  <p id="path"></p>
  <div id="list"></div>
  <script src="app.js"></script>
  <script>
    var now = Date.now();
    var items = [
      { id: "checkout", name: "Checkout 500s in EU", impact: 10, urgency: 9, effort: 4, slaHours: 1, openedAt: now - 2 * 3600e3 },
      { id: "contrast", name: "Dark mode contrast", impact: 4, urgency: 3, effort: 2, slaHours: 72, openedAt: now },
      { id: "auth", name: "Migrate auth tokens", impact: 8, urgency: 6, effort: 7, slaHours: 48, openedAt: now }
    ];
    var dag = topoRank([
      { id: "spec", duration: 2, dependsOn: [] },
      { id: "build", duration: 5, dependsOn: ["spec"] },
      { id: "qa", duration: 3, dependsOn: ["build"] },
      { id: "docs", duration: 1, dependsOn: ["spec"] }
    ]);
    document.getElementById("path").innerHTML = "Critical path <code>" + dag.criticalPath.join(" → ") + "</code> · " + dag.length + " units";
    document.getElementById("list").innerHTML = rank(items, Date.now()).map(function (t) {
      return '<div class="row"><span>' + t.name + (t.breached ? '<span class="bad">SLA BREACHED</span>' : '') + '</span><b>' + t.score.toFixed(1) + '</b></div>';
    }).join("");
  </script>
</body>
</html>
`;

function report(body: Record<string, unknown>): string {
  return JSON.stringify(body, null, 2);
}

function gate(paths: string[], runtimeOk: boolean): Check[] {
  return [
    ...paths.filter((p) => p.endsWith(".js")).map((p) => ({ name: `syntax:${p}`, ok: true })),
    { name: "runtime:test.js", ok: runtimeOk },
    { name: "artifact:index.html", ok: true },
  ];
}

const HEAL_FAIL_STDOUT = `AssertionError [ERR_ASSERTION]: last unit is exclusive
    at Object.<anonymous> (test.js:16)
    actual: [ 'a', 'b' ]
    expected: [ 'a' ]
node test.js exited 1`;

const HEAL_PASS_STDOUT = `[PASS] capacity allows both
[PASS] exclusive last unit
[PASS] empty burst is a no-op
ALL TESTS PASSED (3/3)`;

const healFailReport = report({
  verdict: "REWORK",
  qualityScore: 61,
  pass: 1,
  sandbox: {
    commands: ["node --check solution.js", "node --check test.js", "node --check app.js", "node test.js"],
    runtime: "FAIL",
    stderr: HEAL_FAIL_STDOUT,
  },
  note: "@verifier caught a lost-update race in settleConcurrent and opened a rework cycle.",
});

const healPassReport = report({
  verdict: "VERIFIED_PASS",
  qualityScore: 98,
  pass: 2,
  reworkCycles: 1,
  sandbox: {
    commands: ["node --check solution.js", "node --check test.js", "node --check app.js", "node test.js"],
    runtime: "PASS",
    assertionsPassed: 8,
    stdout: HEAL_PASS_STDOUT,
  },
  rubric: { correctness: 25, testCoverage: 24, architectureAdherence: 25, uiCompleteness: 24 },
});

const guardReport = report({
  verdict: "VERIFIED_PASS",
  qualityScore: 97,
  pass: 1,
  reworkCycles: 0,
  sandbox: {
    commands: ["node --check token-bucket.js", "node --check circuit-breaker.js", "node --check solution.js", "node test.js"],
    runtime: "PASS",
    stdout: "[PASS] token bucket\n[PASS] circuit breaker\n[PASS] guard composition\nALL TESTS PASSED (3/3)",
  },
  rubric: { correctness: 25, testCoverage: 23, architectureAdherence: 25, uiCompleteness: 24 },
});

const dagReport = report({
  verdict: "VERIFIED_PASS",
  qualityScore: 98,
  pass: 1,
  reworkCycles: 0,
  sandbox: {
    commands: ["node --check solution.js", "node --check app.js", "node --check test.js", "node test.js"],
    runtime: "PASS",
    stdout: "[PASS] score bounds\n[PASS] sla breach\n[PASS] rank\n[PASS] critical path\n[PASS] cycle detection\nALL TESTS PASSED (5/5)",
  },
  rubric: { correctness: 25, testCoverage: 24, architectureAdherence: 25, uiCompleteness: 24 },
});

function task(partial: Task): Task {
  return partial;
}

export const LOCAL_SCENARIOS: Scenario[] = [
  {
    id: "self-heal-bugfix",
    title: "Autonomous Bugfix & Self-Healing Patch",
    kicker: "01 · Self-heal",
    description: "Race on the last unit, regression test, then @verifier → @builder rework.",
    expectsRework: true,
    score: 98,
    failScore: 61,
    failStdout: HEAL_FAIL_STDOUT,
    passStdout: HEAL_PASS_STDOUT,
    brief: `Build an autonomous bugfix of a same-tick reservation race.

Deliverables (multi-file workspace):
- brief.md, runbook.md
- solution.js — settleConcurrent(reserves) over a shared stock counter
- app.js — browser preview of the same module
- test.js — zero-dependency node:assert suite
- index.html — button that fires two acquires of the last unit
- verify-report.json — sandbox verdict

Bug to hunt: settleConcurrent reads the pre-loop stock for every request in the burst, so two callers can both take the last unit (lost update). @builder ships the bug with a happy-path test. @verifier adds the exclusive-last-unit regression, runs \`node --check\` and \`node test.js\`, and on failure moves TASK-1 to rework with the assertion trace. @builder patches the compare to use remaining stock and adds an empty-burst regression. @verifier re-runs to VERIFIED_PASS.

Constraints: no npm dependencies. Isomorphic (Node require + browser globals). Rubric is 100 points.`,
    passChecks: gate(["solution.js", "app.js", "test.js"], true),
    failChecks: gate(["solution.js", "app.js", "test.js"], false),
    files: {
      "brief.md": `# Brief — self-heal-bugfix\n\nSame-tick reservation of a shared stock counter.\n\n- settleConcurrent must accept at most one request for the last unit\n- Empty bursts are a no-op\n- @verifier owns \`node --check\` + \`node test.js\` and may open a rework cycle\n`,
      "runbook.md": `# Runbook\n\n1. TASK-1 @builder — solution.js + test.js\n2. TASK-2 @builder — index.html preview (depends on TASK-1)\n3. TASK-3 @verifier — sandbox + verify-report.json (depends on TASK-1, TASK-2)\n\nOn runtime failure: status rework, steer @builder with the stack, patch, re-run.\n`,
      "solution.js": SOL_P2,
      "app.js": SOL_P2,
      "test.js": TEST_P2,
      "index.html": HEAL_HTML,
      "verify-report.json": healPassReport,
      "README.md": `# Reservation settle\n\nSelf-healed by @verifier → @builder.\n\n\`\`\`\nnode --check solution.js && node test.js\n\`\`\`\n\nVerdict: 98/100 VERIFIED_PASS after 1 rework cycle.\n`,
    },
    pass1: {
      "solution.js": SOL_P1,
      "app.js": SOL_P1,
      "test.js": TEST_P1,
      "verify-report.json": healFailReport,
    },
    messages: [
      {
        id: "heal-arch",
        from: "architect",
        to: "builder",
        kind: "STEER",
        text: "Spec is in brief.md. TASK-1: settleConcurrent must serialize a same-tick burst. Ship solution.js, app.js, and test.js. No dependencies.",
        reasoning:
          "The failure mode is a lost update, not a clock bug. Isolate the counter in solution.js so @verifier can fail one assertion without booting a browser. UI waits on TASK-1.",
        tokens: 2840,
        latency: 7.6,
      },
      {
        id: "heal-queue",
        from: "architect",
        to: "verifier",
        kind: "QUEUE",
        text: "Queue TASK-3. Gates: node --check on solution.js, app.js, test.js, then node test.js. The last unit in a burst is exclusive.",
        reasoning:
          "Write the oracle down before the code lands so the rework loop has an objective fail, not a vibe check.",
        tokens: 960,
        latency: 3.4,
      },
      {
        id: "heal-build",
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "TASK-1 first pass is up. Happy-path test is green locally. Please run the sandbox, including a burst against stock = 1.",
        reasoning:
          "I read stock once into `seen` and compared every reservation to that snapshot. That is wrong if two requests share the tick, but the capacity-3 test hides it.",
        tokens: 3120,
        latency: 11.2,
      },
      {
        id: "heal-rw",
        from: "verifier",
        to: "builder",
        kind: "REWORK",
        text: "runtime:test.js ✗ — AssertionError: last unit is exclusive\n    actual [a, b] expected [a]\n    at test.js settleConcurrent stock=1\nTASK-1 → rework.",
        reasoning:
          "node --check is clean. The race is a compare against the pre-loop snapshot. Steer @builder with the actual/expected arrays. Do not rewrite the module boundary.",
        tokens: 1680,
        latency: 6.1,
      },
      {
        id: "fix",
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "Patched settleConcurrent to compare `left`, not `seen`. Added an empty-burst regression. Please re-run node test.js.",
        reasoning:
          "One predicate change. Callers still share the module counter. The new test locks the empty-burst no-op so a later refactor cannot bump seq without accepting a reservation.",
        tokens: 1420,
        latency: 5.5,
      },
      {
        id: "heal-pass",
        from: "verifier",
        to: "lead",
        kind: "STEER",
        text: "Pass 2: node --check ✓ and node test.js ✓ — ALL TESTS PASSED (3/3). Verdict VERIFIED_PASS 98/100. One rework cycle.",
        reasoning:
          "Pass 1 failed the exclusive-unit assertion. Pass 2 matches the regression and the empty burst. Coverage loses a point for not fuzzing qty > stock mixes. Still a pass.",
        tokens: 1544,
        latency: 8.8,
      },
      {
        id: "heal-lead",
        from: "lead",
        to: "all",
        kind: "NOTIFY",
        text: "Released self-heal-bugfix. verify-report.json records Pass 1 REWORK → Pass 2 VERIFIED_PASS. The diff is the lost-update predicate.",
        reasoning:
          "Judges should see the patch, not a story about a patch. Point the studio at solution.js Pass 1 versus Pass 2.",
        tokens: 880,
        latency: 3.9,
      },
    ],
    tasks: [
      task({
        id: "TASK-1",
        title: "Reservation core & race regression",
        assignee: "builder",
        dependsOn: [],
        status: "done",
        audit: [
          "@architect created · ready",
          "@builder → in_progress",
          "@verifier: AssertionError last unit is exclusive → rework",
          "@builder patched left >= qty",
          "@verifier: 3/3 tests pass → done",
        ],
      }),
      task({
        id: "TASK-2",
        title: "Burst preview",
        assignee: "builder",
        dependsOn: ["TASK-1"],
        status: "done",
        audit: ["@architect blocked on TASK-1", "@builder wrote index.html", "@verifier artifact ok → done"],
      }),
      task({
        id: "TASK-3",
        title: "Sandbox QA & verify-report",
        assignee: "verifier",
        dependsOn: ["TASK-1", "TASK-2"],
        status: "done",
        audit: ["@verifier Pass 1 FAIL", "@verifier Pass 2 VERIFIED_PASS", "@lead packaged README.md"],
      }),
    ],
  },
  {
    id: "token-bucket-breaker",
    title: "Distributed Token-Bucket Rate Limiter & Circuit Breaker",
    kicker: "02 · Rate limit",
    description: "Token bucket, breaker, and a guard wired together. Zero-dependency tests.",
    expectsRework: false,
    score: 97,
    passStdout:
      "[PASS] token bucket\n[PASS] circuit breaker\n[PASS] guard composition\nALL TESTS PASSED (3/3)",
    brief: `Build a zero-dependency rate-limit guard for multi-agent fan-out.

Deliverables:
- brief.md, runbook.md
- token-bucket.js — capacity + refillPerSec, tryAcquire(n, now)
- circuit-breaker.js — closed / open / half-open, threshold + resetMs
- solution.js — createGuard() composes both (open breaker wins over throttle)
- app.js — browser bundle of the same three units
- test.js — node:assert, no npm
- index.html — button that drains the bucket then trips the breaker
- verify-report.json

@architect splits the Kanban so the bucket and the breaker can be reviewed apart from the guard. @verifier runs node --check on every .js file and node test.js. Target VERIFIED_PASS on the 100-point rubric.

Invariants:
- refill never exceeds capacity
- open breaker rejects before spending a token
- half-open after resetMs allows one trial
- report(true) closes the breaker`,
    passChecks: gate(["token-bucket.js", "circuit-breaker.js", "solution.js", "app.js", "test.js"], true),
    files: {
      "brief.md": `# Brief — token-bucket-breaker\n\nCompose a token bucket and a circuit breaker.\n\n- tryAcquire refills from elapsed time and never exceeds capacity\n- open breaker short-circuits before a token is spent\n- half-open begins at resetMs\n`,
      "runbook.md": `# Runbook\n\n1. TASK-1 @builder — token-bucket.js + circuit-breaker.js + tests\n2. TASK-2 @builder — solution.js guard + index.html\n3. TASK-3 @verifier — node --check && node test.js → verify-report.json\n`,
      "token-bucket.js": BUCKET_JS,
      "circuit-breaker.js": BREAKER_JS,
      "solution.js": GUARD_JS,
      "app.js": GUARD_BROWSER,
      "test.js": GUARD_TEST,
      "index.html": GUARD_HTML,
      "verify-report.json": guardReport,
      "README.md": `# Guard\n\nToken bucket + circuit breaker. \`node test.js\` prints ALL TESTS PASSED (3/3).\n`,
    },
    messages: [
      {
        id: "guard-arch",
        from: "architect",
        to: "builder",
        kind: "STEER",
        text: "Split the guard. token-bucket.js and circuit-breaker.js stay free of each other. solution.js is the only composer. Tests import all three.",
        reasoning:
          "A single file would hide the short-circuit rule. Separate modules let @verifier fail one invariant without a rewrite of the other.",
        tokens: 2460,
        latency: 8.1,
      },
      {
        id: "guard-queue",
        from: "architect",
        to: "verifier",
        kind: "QUEUE",
        text: "Gates: node --check on token-bucket.js, circuit-breaker.js, solution.js, app.js, test.js, then node test.js. Open breaker must win over throttle.",
        reasoning: "The interesting bug is spending a token while the breaker is open. Put that in the gate list up front.",
        tokens: 880,
        latency: 2.9,
      },
      {
        id: "guard-build",
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "Modules are in. Bucket caps refill. Breaker goes closed → open → half-open. Guard checks the breaker before tryAcquire.",
        reasoning:
          "tryAcquire takes an explicit now so tests do not sleep. record(true) clears openedAt. enter() returns throttled only when the breaker allows the call.",
        tokens: 3340,
        latency: 12.4,
      },
      {
        id: "guard-pass",
        from: "verifier",
        to: "builder",
        kind: "NOTIFY",
        text: "syntax ✓ on 5 files. runtime:test.js ✓ ALL TESTS PASSED (3/3). TASK-1 and TASK-2 → done.",
        reasoning:
          "Refill at t=1000 returns a token without exceeding capacity 2. Half-open at exactly resetMs allows a trial. No rework.",
        tokens: 1210,
        latency: 5.2,
      },
      {
        id: "guard-ui",
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "index.html exercises capacity 2 and then three failures. app.js is the browser bundle of the same units.",
        reasoning: "Preview cannot require(). The bundle is a straight paste of the three functions so the iframe matches node.",
        tokens: 990,
        latency: 4.4,
      },
      {
        id: "guard-final",
        from: "verifier",
        to: "lead",
        kind: "STEER",
        text: "artifact:index.html ✓. Rubric 97/100. VERIFIED_PASS. No rework cycle.",
        reasoning: "Coverage loses two points: no test for acquire(n>1) partial refill. Architecture holds.",
        tokens: 760,
        latency: 3.6,
      },
      {
        id: "guard-lead",
        from: "lead",
        to: "all",
        kind: "NOTIFY",
        text: "Released token-bucket-breaker. verify-report.json is the judge proof. 97/100 VERIFIED_PASS.",
        reasoning: "Hand the rubric and the sandbox stdout to @all. Nothing else is blocking.",
        tokens: 640,
        latency: 2.8,
      },
    ],
    tasks: [
      task({
        id: "TASK-1",
        title: "Bucket, breaker, and unit tests",
        assignee: "builder",
        dependsOn: [],
        status: "done",
        audit: ["@architect created · ready", "@builder wrote token-bucket.js, circuit-breaker.js", "@verifier 3/3 → done"],
      }),
      task({
        id: "TASK-2",
        title: "Guard composition & preview",
        assignee: "builder",
        dependsOn: ["TASK-1"],
        status: "done",
        audit: ["@builder wrote solution.js + index.html", "@verifier artifact ok → done"],
      }),
      task({
        id: "TASK-3",
        title: "Sandbox verification",
        assignee: "verifier",
        dependsOn: ["TASK-1", "TASK-2"],
        status: "done",
        audit: ["@verifier node --check + node test.js", "@lead packaged verify-report.json → done"],
      }),
    ],
  },
  {
    id: "dag-sprint-priority",
    title: "DAG Sprint Priority & Dependency Engine",
    kicker: "03 · DAG engine",
    description: "Topological order, critical path, and weighted SLA rank. 100-point rubric.",
    expectsRework: false,
    score: 98,
    passStdout:
      "[PASS] score bounds\n[PASS] sla breach\n[PASS] rank\n[PASS] critical path\n[PASS] cycle detection\nALL TESTS PASSED (5/5)",
    brief: `Build the sprint priority engine: a DAG critical path plus a weighted ranker.

Deliverables:
- brief.md, runbook.md
- solution.js and app.js (same isomorphic module)
- test.js — node:assert, at least the bounds, SLA, rank, critical path, and cycle cases
- index.html — ranked incidents plus the critical path
- verify-report.json — 100-point rubric

Scoring: impact 0.5, urgency 0.35, (10 − effort) 0.15. SLA breaches sort first.
topoRank(tasks) returns { order, criticalPath, length } using Kahn's algorithm.
Throw if the graph contains a cycle.
Duration defaults to 1. Critical path is the longest dependency chain.

@verifier runs node --check and node test.js. Target ≥ 90 and VERIFIED_PASS.`,
    passChecks: gate(["solution.js", "app.js", "test.js"], true),
    files: {
      "brief.md": `# Brief — dag-sprint-priority\n\nTwo pure functions, one UI.\n\n- rank(): impact 0.5 · urgency 0.35 · (10 − effort) 0.15, breached items first\n- topoRank(): Kahn order + longest-path critical path\n- cycle → throw\n- slaBreached compares hours to elapsed ms (× 3600e3)\n`,
      "runbook.md": `# Runbook\n\n1. TASK-1 @builder — solution.js / app.js + test.js\n2. TASK-2 @builder — index.html (depends on TASK-1)\n3. TASK-3 @verifier — sandbox gates + 100-point rubric (depends on TASK-1, TASK-2)\n\nGates: node --check solution.js · node --check app.js · node --check test.js · node test.js\n`,
      "solution.js": DAG_JS,
      "app.js": DAG_JS,
      "test.js": DAG_TEST,
      "index.html": DAG_HTML,
      "verify-report.json": dagReport,
      "README.md": `# Sprint DAG\n\nCritical path + SLA rank. \`node test.js\` → ALL TESTS PASSED (5/5). Score 98/100 VERIFIED_PASS.\n`,
      "benchmark.json": JSON.stringify(
        {
          session: "dag-sprint-priority",
          model: "meta-models/muse-spark-open-1026",
          score: 98,
          verdict: "VERIFIED_PASS",
          sandbox: "node --check && node test.js",
        },
        null,
        2,
      ),
    },
    messages: [
      {
        id: "dag-arch",
        from: "architect",
        to: "builder",
        kind: "STEER",
        text: "TASK-1 is the pure module: score, slaBreached, rank, topoRank. Cycles throw. Critical path is the longest duration chain. Tests live in test.js.",
        reasoning:
          "Rank and topo are independent. Shipping them in one isomorphic file keeps the iframe and the sandbox on the same source. SLA units are ms; the spec says hours.",
        tokens: 3010,
        latency: 9.4,
      },
      {
        id: "dag-queue",
        from: "architect",
        to: "verifier",
        kind: "QUEUE",
        text: "Rubric gates: bounds of score(), SLA true/false, breached item sorts first, critical path spec→build→qa length 10, cycle throws.",
        reasoning: "Five named cases cover the 100-point rubric without a snapshot of the whole DOM.",
        tokens: 1010,
        latency: 3.2,
      },
      {
        id: "dag-build",
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "solution.js and app.js match. Kahn's algorithm, then a forward longest-path. test.js has the five cases. Ready for node test.js.",
        reasoning:
          "Queue starts with indegree 0 in input order, so spec is first. qa cannot precede build. Equal parent distances keep the later parent; the demo graph has a unique longest path.",
        tokens: 3580,
        latency: 14.8,
      },
      {
        id: "dag-pass",
        from: "verifier",
        to: "builder",
        kind: "NOTIFY",
        text: "node --check ✓ · node test.js ✓ ALL TESTS PASSED (5/5). TASK-1 → done. TASK-2 unblocked.",
        reasoning: "Cycle assertion throws /cycle/. SLA uses 3600e3. No rework.",
        tokens: 1320,
        latency: 6.4,
      },
      {
        id: "dag-ui",
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "index.html renders the critical path and a live ranked list with SLA badges.",
        reasoning: "Seed three incidents so a breached checkout row is visible without typing.",
        tokens: 1180,
        latency: 7.1,
      },
      {
        id: "dag-final",
        from: "verifier",
        to: "lead",
        kind: "STEER",
        text: "artifact:index.html ✓. Rubric 98/100 VERIFIED_PASS. Over to you.",
        reasoning: "UI loses a point for no keyboard reorder. Correctness, coverage, and architecture are full.",
        tokens: 940,
        latency: 4.7,
      },
      {
        id: "dag-lead",
        from: "lead",
        to: "all",
        kind: "NOTIFY",
        text: "Released dag-sprint-priority. benchmark.json + verify-report.json published. 98/100 VERIFIED_PASS.",
        reasoning: "The release note should name the sandbox command and the score, then stop.",
        tokens: 720,
        latency: 3.3,
      },
    ],
    tasks: [
      task({
        id: "TASK-1",
        title: "Ranker, topoRank, critical path, tests",
        assignee: "builder",
        dependsOn: [],
        status: "done",
        audit: ["@architect created · ready", "@builder wrote solution.js + test.js", "@verifier 5/5 → done"],
      }),
      task({
        id: "TASK-2",
        title: "Interactive sprint board",
        assignee: "builder",
        dependsOn: ["TASK-1"],
        status: "done",
        audit: ["@builder wrote index.html", "@verifier artifact ok → done"],
      }),
      task({
        id: "TASK-3",
        title: "100-point rubric verification",
        assignee: "verifier",
        dependsOn: ["TASK-1", "TASK-2"],
        status: "done",
        audit: ["@verifier sandbox pass", "@lead wrote benchmark.json → done"],
      }),
    ],
  },
];

export function filesForPass(scenario: Scenario, pass: 1 | 2): Record<string, string> {
  if (pass === 2 || !scenario.pass1) return scenario.files;
  return { ...scenario.files, ...scenario.pass1 };
}

function pulse(
  id: AgentId,
  state: AgentState,
  extra?: Partial<Record<AgentId, AgentState>>,
): Partial<Record<AgentId, AgentState>> {
  return { ...extra, [id]: state };
}

export function playback(scenario: Scenario, broken: boolean, runId: string): PlaybackStep[] {
  const heal = broken && scenario.expectsRework && Boolean(scenario.pass1);
  const msgs = scenario.messages.filter((m) => heal || (m.kind !== "REWORK" && m.id !== "fix"));
  const steps: PlaybackStep[] = [{ delay: 420, agents: { architect: "THINKING" } }];
  for (const msg of msgs) {
    const tagged: Message = { ...msg, id: `${msg.id}-${runId}` };
    if (msg.kind === "REWORK") {
      const step: PlaybackStep = {
        delay: 880,
        agents: { builder: "IDLE", verifier: "STEERING" },
        msg: tagged,
        tasks: { "TASK-1": { status: "rework", note: "@verifier → rework" } },
        files: filesForPass(scenario, 1),
        phase: "pass1",
      };
      if (scenario.failChecks) step.checks = scenario.failChecks;
      if (scenario.failScore !== undefined) step.score = scenario.failScore;
      steps.push(step);
      steps.push({ delay: 520, agents: { verifier: "IDLE", builder: "THINKING" } });
      continue;
    }
    if (msg.id === "fix") {
      steps.push({
        delay: 860,
        agents: { builder: "STEERING", verifier: "TESTING" },
        msg: tagged,
        tasks: { "TASK-1": { status: "in_progress", note: "@builder patched" } },
        files: scenario.files,
        phase: "pass2",
      });
      continue;
    }
    if (msg.from === "builder") {
      const step: PlaybackStep = {
        delay: 780,
        agents: pulse("builder", "STEERING", { verifier: "TESTING" }),
        msg: tagged,
        tasks: { "TASK-1": { status: "in_progress", note: "@builder → in_progress" } },
      };
      if (heal) {
        step.files = filesForPass(scenario, 1);
        step.phase = "pass1";
      } else {
        step.files = scenario.files;
        step.phase = "pass2";
      }
      steps.push(step);
      continue;
    }
    if (msg.from === "verifier" && msg.kind !== "QUEUE") {
      steps.push({
        delay: 820,
        agents: { verifier: "STEERING", builder: "IDLE", lead: "THINKING" },
        msg: tagged,
        checks: scenario.passChecks,
        score: scenario.score,
        files: scenario.files,
        phase: "pass2",
        tasks: {
          "TASK-1": { status: "done", note: "@verifier pass → done" },
          "TASK-2": { status: "done", note: "@verifier artifact ok → done" },
        },
      });
      continue;
    }
    if (msg.from === "lead") {
      steps.push({
        delay: 680,
        agents: { lead: "STEERING", verifier: "IDLE" },
        msg: tagged,
        tasks: { "TASK-3": { status: "done", note: "@lead packaged release → done" } },
      });
      continue;
    }
    steps.push({
      delay: 640,
      agents: pulse(msg.from, "STEERING"),
      msg: tagged,
    });
  }
  steps.push({
    delay: 360,
    agents: { architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" },
  });
  return steps;
}

export function resetTasks(tasks: Task[]): Task[] {
  return tasks.map((t) => ({
    ...t,
    status: "ready",
    audit: ["@architect initializing…"],
  }));
}

const first = LOCAL_SCENARIOS[0];
export const DEFAULT_SCENARIO: Scenario = first ?? {
  id: "self-heal-bugfix",
  title: "Autonomous Bugfix & Self-Healing Patch",
  kicker: "01",
  description: "",
  brief: "",
  expectsRework: true,
  files: {},
  messages: [],
  tasks: [],
  passChecks: [],
  passStdout: "",
  score: 0,
};
