export type AgentId = "architect" | "builder" | "verifier" | "lead";
export type AgentState = "IDLE" | "THINKING" | "STEERING" | "TESTING";
export type TaskStatus = "ready" | "in_progress" | "rework" | "done";
export type MsgKind = "STEER" | "QUEUE" | "NOTIFY" | "REWORK";

export interface Agent {
  id: AgentId;
  role: string;
  tools: string[];
  soul: string;
}
export interface Task {
  id: string;
  title: string;
  assignee: AgentId;
  dependsOn: string[];
  status: TaskStatus;
  audit: string[];
}
export interface Message {
  id: string;
  from: AgentId;
  to: AgentId | "all";
  kind: MsgKind;
  text: string;
  reasoning: string;
  tokens: number;
  latency: number;
}

export const MODEL = "meta-models/muse-spark-open-1026";
export const TPM_LIMIT = 2_000_000;

export const AGENTS: Agent[] = [
  { id: "architect", role: "System Architect & Kanban Arbiter", tools: ["kanban", "file_spec", "session_message"], soul: "# SOUL.md — @architect\nYou own the spec. Decompose the brief into dependency-aware tasks, write brief.md and runbook.md, and arbitrate the Kanban board. Never write implementation code." },
  { id: "builder", role: "Full-Stack Implementation Specialist", tools: ["file_write", "kanban", "session_message"], soul: "# SOUL.md — @builder\nYou implement exactly what the spec says. Ship isomorphic modules, keep tests green, and patch immediately when @verifier steers you with a stack trace." },
  { id: "verifier", role: "Autonomous QA, Security & Runtime Critic", tools: ["test_runner", "kanban", "session_message"], soul: "# SOUL.md — @verifier\nYou trust nothing. Run node --check and node test.js in the sandbox, score against the 100-point rubric, and move failing tasks to rework." },
  { id: "lead", role: "Synthesizer & DevRel Lead", tools: ["file_write", "session_message"], soul: "# SOUL.md — @lead\nYou synthesize the session into README.md and benchmark.json and broadcast the release to @all once VERIFIED_PASS." },
];

export const APP_JS = `// app.js — Sprint & Incident Priority Engine (isomorphic)
const W = { impact: 0.5, urgency: 0.35, effort: 0.15 };
function score(t) {
  const s = t.impact * W.impact + t.urgency * W.urgency + (10 - t.effort) * W.effort;
  return Math.round(s * 10) / 10;
}
function slaBreached(t, now = Date.now()) {
  return t.slaHours != null && now - t.openedAt > t.slaHours * 3600e3;
}
function rank(items, now) {
  return items
    .map((t) => ({ ...t, score: score(t), breached: slaBreached(t, now) }))
    .sort((a, b) => (b.breached - a.breached) || (b.score - a.score));
}
if (typeof module !== "undefined") module.exports = { score, slaBreached, rank };
`;

export const TEST_JS = `// test.js
const assert = require("assert");
const { score, slaBreached, rank } = require("./app.js");
assert.strictEqual(score({ impact: 10, urgency: 10, effort: 0 }), 10);
assert.strictEqual(score({ impact: 0, urgency: 0, effort: 10 }), 0);
assert.ok(slaBreached({ slaHours: 1, openedAt: 0 }, 7200e3));
assert.ok(!slaBreached({ slaHours: 4, openedAt: 0 }, 3600e3));
const r = rank([{ id: "a", impact: 2, urgency: 2, effort: 5 }, { id: "b", impact: 9, urgency: 8, effort: 3 }], 0);
assert.strictEqual(r[0].id, "b");
console.log("ALL TESTS PASSED (5/5)");
`;

export const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#000;color:#f5f5f7;padding:20px}
h1{font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0 0 4px}p{color:#86868b;font-size:12px;margin:0 0 16px}
form{display:grid;grid-template-columns:2fr repeat(4,1fr) auto;gap:6px;margin-bottom:14px}
input,button{background:#1c1c1e;border:1px solid #2c2c2e;color:#f5f5f7;border-radius:10px;padding:8px;font-size:12px}
button{background:#0a84ff;border:0;font-weight:600;cursor:pointer}
.row{display:flex;justify-content:space-between;align-items:center;background:#1c1c1e;border-radius:12px;padding:10px 12px;margin-bottom:6px;font-size:13px}
.s{font-weight:600;font-variant-numeric:tabular-nums}.b{color:#ff453a;font-size:11px;margin-left:8px}
</style></head><body>
<h1>Sprint & Incident Priority Engine</h1><p>Weighted impact · urgency · effort, with SLA breach detection.</p>
<form id="f"><input id="n" placeholder="Task name" required><input id="i" type="number" min="0" max="10" placeholder="Impact" required><input id="u" type="number" min="0" max="10" placeholder="Urgency" required><input id="e" type="number" min="0" max="10" placeholder="Effort" required><input id="h" type="number" min="0" placeholder="SLA h"><button>Add</button></form>
<div id="list"></div>
<script>__APP__
const now=Date.now();let items=[
{name:"Checkout 500s in EU",impact:10,urgency:9,effort:4,slaHours:1,openedAt:now-2*3600e3},
{name:"Dark mode contrast bug",impact:4,urgency:3,effort:2,slaHours:72,openedAt:now},
{name:"Migrate auth tokens",impact:8,urgency:6,effort:7,slaHours:48,openedAt:now},
{name:"Flaky CI on main",impact:6,urgency:7,effort:3,slaHours:24,openedAt:now-30*3600e3}];
function render(){document.getElementById("list").innerHTML=rank(items,Date.now()).map(t=>'<div class="row"><span>'+t.name+(t.breached?'<span class="b">SLA BREACHED</span>':'')+'</span><span class="s">'+t.score.toFixed(1)+'</span></div>').join("")}
document.getElementById("f").onsubmit=e=>{e.preventDefault();const v=id=>document.getElementById(id).value;items.push({name:v("n"),impact:+v("i"),urgency:+v("u"),effort:+v("e"),slaHours:v("h")?+v("h"):null,openedAt:Date.now()});e.target.reset();render()};render();
</script></body></html>`;

export const MCP_JSON = `{
  "mcpServers": {
    "muse-swarm": {
      "command": "npx",
      "args": ["-y", "muse-swarm", "mcp"],
      "env": { "BASETEN_API_KEY": "\${env:BASETEN_API_KEY}" },
      "tools": [
        "muse_swarm_list_agents",
        "muse_swarm_ask_agent",
        "muse_swarm_cobuild",
        "muse_swarm_telemetry"
      ]
    }
  }
}`;

export const DEMO_FILES: Record<string, string> = {
  "brief.md": "# Brief — sprint-priority-engine-8z24\n\nBuild a Real-Time Engineering Sprint & Incident Priority Engine.\n\n- Weighted score: impact 0.5 · urgency 0.35 · (10 − effort) 0.15\n- SLA breach detector floats breached items to the top\n- Deliverables: app.js (isomorphic), test.js, index.html",
  "runbook.md": "# Runbook\n\n1. TASK-1 @builder — core engine + unit tests\n2. TASK-2 @builder — interactive UI (depends on TASK-1)\n3. TASK-3 @verifier — sandbox QA + release (depends on TASK-1, TASK-2)\n\nGates: node --check app.js · node --check test.js · node test.js",
  "app.js": APP_JS,
  "test.js": TEST_JS,
  "index.html": INDEX_HTML.replace("__APP__", "/* app.js inlined */"),
  "README.md": "# Sprint & Incident Priority Engine\n\nCo-built by four Muse Spark Open peer agents via MuseSwarm Studio.\n\n```\nnode test.js   # ALL TESTS PASSED (5/5)\nopen index.html\n```\n\nScore: 98/100 VERIFIED_PASS",
  "benchmark.json": JSON.stringify({ session: "sprint-priority-engine-8z24", model: MODEL, tokens: 16916, reasoningTokens: 8260, calls: 4, retries: 0, p50: 9.2, p95: 18.1, score: 98, verdict: "VERIFIED_PASS" }, null, 2),
  ".cursor/mcp.json": MCP_JSON,
};

export const DEMO_TASKS: Task[] = [
  { id: "TASK-1", title: "Core Engine & Unit Tests", assignee: "builder", dependsOn: [], status: "done", audit: ["@architect created · ready", "@builder → in_progress", "@builder wrote app.js, test.js", "@verifier: 5/5 tests pass → done"] },
  { id: "TASK-2", title: "Interactive UI & Integration", assignee: "builder", dependsOn: ["TASK-1"], status: "done", audit: ["@architect created · blocked by TASK-1", "@builder → in_progress", "@builder wrote index.html", "@verifier: artifact check ok → done"] },
  { id: "TASK-3", title: "Sandbox QA & Release Package", assignee: "verifier", dependsOn: ["TASK-1", "TASK-2"], status: "done", audit: ["@architect created · blocked", "@verifier ran 4 sandbox checks", "@lead packaged README.md, benchmark.json → done"] },
];

export const DEMO_MESSAGES: Message[] = [
  { id: "m1", from: "architect", to: "builder", kind: "STEER", text: "Spec is in brief.md. TASK-1 is yours: implement score(), slaBreached(), rank() as an isomorphic module, plus test.js with ≥5 assertions.", reasoning: "The brief has three concerns: scoring, SLA, UI. Scoring and SLA are pure functions — isolate them in app.js so they're testable in Node and reusable in the browser. UI depends on them, so TASK-2 blocks on TASK-1.", tokens: 3120, latency: 8.4 },
  { id: "m2", from: "architect", to: "verifier", kind: "QUEUE", text: "Queueing TASK-3 for you. Gates: node --check on both files, node test.js, and index.html must render a ranked list.", reasoning: "Verifier needs explicit gates up front so the rubric is objective, not vibes.", tokens: 980, latency: 3.1 },
  { id: "m3", from: "builder", to: "verifier", kind: "STEER", text: "TASK-1 complete. app.js exports score/slaBreached/rank; test.js has 5 assertions. Ready for sandbox run.", reasoning: "Weights sum to 1.0. Effort is inverted (10 − effort) so cheap work ranks higher. Sorting puts breached items first, then score desc.", tokens: 4210, latency: 12.6 },
  { id: "m4", from: "verifier", to: "builder", kind: "NOTIFY", text: "syntax:app.js ✓ syntax:test.js ✓ runtime:test.js ✓ — ALL TESTS PASSED (5/5). TASK-1 → done. TASK-2 unblocked.", reasoning: "All three runtime gates pass. Edge cases: null slaHours returns false correctly. Moving on.", tokens: 1840, latency: 6.2 },
  { id: "m5", from: "builder", to: "verifier", kind: "STEER", text: "TASK-2 complete. index.html inlines app.js, supports adding tasks live, highlights SLA breaches.", reasoning: "Keep the UI dependency-free so it runs in any sandbox iframe. Seed 4 realistic items so the preview is meaningful immediately.", tokens: 3460, latency: 18.1 },
  { id: "m6", from: "verifier", to: "lead", kind: "STEER", text: "artifact:index.html ✓. Rubric 98/100 (Coverage 24, UI 24). Verdict VERIFIED_PASS. Over to you for release.", reasoning: "Coverage loses one point: no test for equal-score tiebreak. UI loses one: no keyboard sort control. Both minor — pass.", tokens: 1676, latency: 9.2 },
  { id: "m7", from: "lead", to: "all", kind: "NOTIFY", text: "🚀 Released sprint-priority-engine-8z24 — README.md and benchmark.json published. 16,916 tokens, 4 calls, 0 retries.", reasoning: "Summarize the outcome for humans: what it does, how to run it, and the verified score.", tokens: 1630, latency: 4.0 },
];

export const PRESETS = [
  "Build a Real-Time Engineering Sprint & Incident Priority Engine with weighted impact/urgency/effort scoring, SLA breach detector, interactive dark-mode UI (index.html), isomorphic core module (app.js), and unit test suite (test.js)",
  "Build a Feature Flag Rollout Planner with percentage cohorts, kill-switch rules, UI (index.html), core module (app.js) and tests (test.js)",
  "Build an On-Call Rotation Fairness Scheduler with load balancing, holiday swaps, UI (index.html), core module (app.js) and tests (test.js)",
];
