import type { AgentId, AgentState, Message, Task, TaskStatus } from "./swarm-data.ts";
// Preset module is plain CommonJS. self-check.ts asserts ids, titles, briefs, and faults.
// @ts-expect-error no declaration file beside src/scenarios.js
import scenarios from "../../../src/scenarios.js";

const serializeScenarios = scenarios.serializeScenarios as () => SerializedScenario[];
const applyPass1Fault = scenarios.applyPass1Fault as (
  artifacts: Record<string, string>,
  scenarioId: string,
) => Pass1Fault | null;

type SerializedScenario = {
  id: string;
  title: string;
  tagline: string;
  prompt: string;
  projectName: string;
  highlights: string[];
  pass1Fault: { file: string; summary: string };
  artifacts: Record<string, string>;
};

type Pass1Fault = { file: string; clean: string; broken: string };

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

function gate(paths: string[], runtimeOk: boolean): Check[] {
  return [
    ...paths.filter((p) => p.endsWith(".js")).map((p) => ({ name: `syntax:${p}`, ok: true })),
    { name: "runtime:test.js", ok: runtimeOk },
    { name: "artifact:index.html", ok: true },
  ];
}

function messagesFor(preset: SerializedScenario): Message[] {
  const fault = preset.pass1Fault.summary;
  const file = preset.pass1Fault.file;
  return [
    {
      id: "arch",
      from: "architect",
      to: "builder",
      kind: "STEER",
      text: `Spec is in brief.md. ${preset.prompt}`,
      reasoning: preset.tagline,
      tokens: 2480,
      latency: 7.4,
    },
    {
      id: "queue",
      from: "architect",
      to: "verifier",
      kind: "QUEUE",
      text: `Gates for ${preset.id}: node --check on domain.js, app.js, and test.js, then node test.js.`,
      reasoning: "The rubric is the sandbox result, not a vibe check.",
      tokens: 920,
      latency: 3.1,
    },
    {
      id: "build",
      from: "builder",
      to: "verifier",
      kind: "STEER",
      text: `TASK-1 is in. ${file}, app.js, test.js, and index.html match the preset. Please run node test.js.`,
      reasoning: preset.highlights.join(" "),
      tokens: 2860,
      latency: 11.4,
    },
    {
      id: "rw",
      from: "verifier",
      to: "builder",
      kind: "REWORK",
      text: `runtime:test.js ✗ — ${fault} TASK-1 → rework.`,
      reasoning: `node --check is clean. The failing assertion is the Pass 1 fault in ${file}.`,
      tokens: 1640,
      latency: 6.2,
    },
    {
      id: "fix",
      from: "builder",
      to: "verifier",
      kind: "STEER",
      text: `Patched ${file}. Pass 1 fault removed: ${fault} Please re-run node test.js.`,
      reasoning: "One predicate restored to the preset. No other callers change.",
      tokens: 1180,
      latency: 4.6,
    },
    {
      id: "pass",
      from: "verifier",
      to: "lead",
      kind: "STEER",
      text: "Pass 2: node --check ✓ and node test.js ✓. Verdict VERIFIED_PASS.",
      reasoning: "Pass 1 failed on the seeded fault. Pass 2 matches the preset.",
      tokens: 1010,
      latency: 6.4,
    },
    {
      id: "lead",
      from: "lead",
      to: "all",
      kind: "NOTIFY",
      text: `Released ${preset.id}. README.md is in the workspace. VERIFIED_PASS.`,
      reasoning: "Name the scenario id and the sandbox verdict, then stop.",
      tokens: 720,
      latency: 3.4,
    },
  ];
}

function tasksFor(preset: SerializedScenario): Task[] {
  const file = preset.pass1Fault.file;
  return [
    {
      id: "TASK-1",
      title: `${file} core and tests`,
      assignee: "builder",
      dependsOn: [],
      status: "done",
      audit: [
        "@architect created · ready",
        `@builder wrote ${file}, app.js, test.js`,
        `@verifier: ${preset.pass1Fault.summary}`,
        "@verifier: node test.js pass → done",
      ],
    },
    {
      id: "TASK-2",
      title: "Interactive preview",
      assignee: "builder",
      dependsOn: ["TASK-1"],
      status: "done",
      audit: ["@builder wrote index.html", "@verifier artifact ok → done"],
    },
    {
      id: "TASK-3",
      title: "Sandbox QA",
      assignee: "verifier",
      dependsOn: ["TASK-1", "TASK-2"],
      status: "done",
      audit: ["@verifier node --check + node test.js", "@lead packaged README.md → done"],
    },
  ];
}

/** Offline copy of GET /api/scenarios. Ids, titles, prompts, and pass-1 faults come from src/scenarios.js. */
export const LOCAL_SCENARIOS: Scenario[] = (serializeScenarios() as SerializedScenario[]).map((preset, index) => {
  const fault = applyPass1Fault(preset.artifacts, preset.id) as Pass1Fault | null;
  if (!fault) throw new Error(`missing pass-1 fault for ${preset.id}`);
  const jsFiles = Object.keys(preset.artifacts).filter((name) => name.endsWith(".js"));
  return {
    id: preset.id,
    title: preset.title,
    kicker: `${String(index + 1).padStart(2, "0")} · ${preset.id}`,
    description: preset.pass1Fault.summary,
    brief: preset.prompt,
    expectsRework: false,
    files: preset.artifacts,
    pass1: { [fault.file]: fault.broken },
    messages: messagesFor(preset),
    tasks: tasksFor(preset),
    failChecks: gate(jsFiles, false),
    passChecks: gate(jsFiles, true),
    failStdout: preset.pass1Fault.summary,
    passStdout: "node test.js\nVERIFIED_PASS",
    failScore: 61,
    score: 98,
  };
});

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
  const heal = broken && Boolean(scenario.pass1);
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
  id: "sprint-priority-engine",
  title: "Real-Time Engineering Sprint & Incident Priority Engine",
  kicker: "01",
  description: "",
  brief: "",
  expectsRework: false,
  files: {},
  messages: [],
  tasks: [],
  passChecks: [],
  passStdout: "",
  score: 0,
};
