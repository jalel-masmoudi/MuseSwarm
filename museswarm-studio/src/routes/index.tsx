import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AGENTS,
  APP_JS,
  DEMO_FILES,
  DEMO_MESSAGES,
  DEMO_TASKS,
  INDEX_HTML,
  MCP_JSON,
  MODEL,
  PRESETS,
  TEST_JS,
  TPM_LIMIT,
  type AgentId,
  type AgentState,
  type Message,
  type MsgKind,
  type Task,
  type TaskStatus,
} from "@/lib/swarm-data";

const AGENT_TEXT: Record<AgentId, string> = {
  architect: "text-architect",
  builder: "text-builder",
  verifier: "text-verifier",
  lead: "text-lead",
};
const AGENT_BG: Record<AgentId, string> = {
  architect: "bg-architect",
  builder: "bg-builder",
  verifier: "bg-verifier",
  lead: "bg-lead",
};
const KIND_STYLE: Record<MsgKind, string> = {
  STEER: "bg-primary/15 text-primary",
  QUEUE: "bg-secondary text-muted-foreground",
  NOTIFY: "bg-builder/15 text-builder",
  REWORK: "bg-destructive/15 text-destructive",
};
const STATUS_STYLE: Record<string, string> = {
  ready: "bg-secondary text-muted-foreground",
  in_progress: "bg-primary/15 text-primary",
  rework: "bg-destructive/15 text-destructive",
  done: "bg-builder/15 text-builder",
};

type Step = {
  delay: number;
  agents?: Partial<Record<AgentId, AgentState>>;
  msg?: Message;
  tasks?: Record<string, Partial<Task> & { note?: string }>;
  checks?: Check[];
  score?: number;
};
type Check = { name: string; ok: boolean };
const PASS_CHECKS: Check[] = [
  "syntax:app.js",
  "syntax:test.js",
  "runtime:test.js",
  "artifact:index.html",
].map((name) => ({ name, ok: true }));

function normalizeAgentId(raw?: string): AgentId {
  const clean = String(raw || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (clean === "architect" || clean === "builder" || clean === "verifier" || clean === "lead") {
    return clean;
  }
  return "architect";
}

function normalizeRecipient(raw?: string): AgentId | "all" {
  const clean = String(raw || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (clean === "all" || clean === "user") return "all";
  return normalizeAgentId(clean);
}

function mapBackendMessage(m: any, idx: number): Message {
  const phase = m.metadata?.phase || "";
  const rawDel = String(m.delivery || "steer").toUpperCase();
  const kind: MsgKind =
    phase === "rework_request"
      ? "REWORK"
      : rawDel === "QUEUE" || rawDel === "NOTIFY" || rawDel === "STEER"
        ? (rawDel as MsgKind)
        : "STEER";

  const estTokens =
    m.metadata?.tokens ||
    Math.max(480, Math.round(((m.content?.length || 0) + (m.reasoning?.length || 0)) * 0.9));
  const estLatency = m.metadata?.latencyMs
    ? Number((m.metadata.latencyMs / 1000).toFixed(1))
    : Number((2.4 + (idx % 4) * 1.7).toFixed(1));

  return {
    id: m.id || `msg-${idx}-${Date.now()}`,
    from: normalizeAgentId(m.from),
    to: normalizeRecipient(m.to),
    kind,
    text: String(m.content || ""),
    reasoning: String(m.reasoning || "(concise reasoning step completed)"),
    tokens: estTokens,
    latency: estLatency,
  };
}

function mapBackendTask(t: any): Task {
  const auditLines: string[] = [];
  if (Array.isArray(t.history)) {
    for (const h of t.history) {
      auditLines.push(`${h.author || "@system"}: ${h.from ? `${h.from} → ` : ""}${h.to}`);
    }
  }
  if (Array.isArray(t.comments)) {
    for (const c of t.comments) {
      auditLines.push(`${c.author || "@agent"}: ${c.text}`);
    }
  }
  const deps = Array.isArray(t.dependsOn) && t.dependsOn.length > 0
    ? t.dependsOn
    : t.parentId
      ? [t.parentId]
      : [];
  const rawStatus = String(t.status || "ready");
  const status: TaskStatus =
    rawStatus === "in_progress" || rawStatus === "rework" || rawStatus === "done"
      ? rawStatus
      : "ready";

  return {
    id: t.id,
    title: t.title,
    assignee: normalizeAgentId(t.assignee),
    dependsOn: deps,
    status,
    audit: auditLines.length > 0 ? auditLines : ["@architect created · ready"],
  };
}

function buildSteps(broken: boolean): Step[] {
  const s: Step[] = [];
  const m = (i: number): Message => ({
    ...DEMO_MESSAGES[i]!,
    id: `${DEMO_MESSAGES[i]!.id}-${Date.now()}-${i}`,
  });
  s.push({ delay: 600, agents: { architect: "THINKING" } });
  s.push({
    delay: 1400,
    agents: { architect: "STEERING" },
    msg: m(0),
    tasks: { "TASK-1": { status: "ready", note: "@architect created · ready" } },
  });
  s.push({ delay: 900, msg: m(1), agents: { architect: "IDLE", builder: "THINKING" } });
  s.push({ delay: 1500, tasks: { "TASK-1": { status: "in_progress", note: "@builder → in_progress" } } });
  s.push({ delay: 1200, agents: { builder: "STEERING", verifier: "TESTING" }, msg: m(2) });
  if (broken) {
    const fail: Check[] = [
      { name: "syntax:app.js", ok: true },
      { name: "syntax:test.js", ok: true },
      { name: "runtime:test.js", ok: false },
      { name: "artifact:index.html", ok: false },
    ];
    s.push({
      delay: 1400,
      agents: { builder: "IDLE", verifier: "STEERING" },
      checks: fail,
      score: 61,
      tasks: { "TASK-1": { status: "rework", note: "@verifier: AssertionError at test.js:4 → rework" } },
      msg: {
        id: `rw-${Date.now()}`,
        from: "verifier",
        to: "builder",
        kind: "REWORK",
        text: "runtime:test.js ✗ — AssertionError [ERR_ASSERTION]: false == true\n    at test.js:4 slaBreached({slaHours:1, openedAt:0}, 7200e3)\nslaBreached compares hours to ms. TASK-1 → rework.",
        reasoning:
          "The test expects a breach after 2h on a 1h SLA. The implementation compares elapsed ms to raw slaHours — unit mismatch. Steer builder with the trace.",
        tokens: 1420,
        latency: 5.8,
      },
    });
    s.push({ delay: 1200, agents: { verifier: "IDLE", builder: "THINKING" } });
    s.push({
      delay: 1600,
      agents: { builder: "STEERING", verifier: "TESTING" },
      tasks: { "TASK-1": { status: "in_progress", note: "@builder patched slaHours * 3600e3" } },
      msg: {
        id: `fx-${Date.now()}`,
        from: "builder",
        to: "verifier",
        kind: "STEER",
        text: "Patched: slaBreached now converts slaHours × 3600e3 to ms. Please re-run.",
        reasoning:
          "One-line fix. Re-read the spec: SLA is in hours, timestamps in ms. No other callers affected.",
        tokens: 960,
        latency: 4.4,
      },
    });
  }
  s.push({
    delay: 1400,
    agents: { builder: "IDLE", verifier: "STEERING" },
    msg: m(3),
    checks: PASS_CHECKS.slice(0, 3).concat([{ name: "artifact:index.html", ok: false }]),
    tasks: {
      "TASK-1": { status: "done", note: "@verifier: 5/5 tests pass → done" },
      "TASK-2": { status: "in_progress", note: "@builder → in_progress" },
    },
  });
  s.push({ delay: 1500, agents: { verifier: "IDLE", builder: "STEERING" }, msg: m(4) });
  s.push({
    delay: 1300,
    agents: { builder: "IDLE", verifier: "TESTING" },
    tasks: {
      "TASK-2": { status: "done", note: "@verifier: artifact check ok → done" },
      "TASK-3": { status: "in_progress", note: "@verifier ran 4 sandbox checks" },
    },
  });
  s.push({ delay: 1200, agents: { verifier: "STEERING", lead: "THINKING" }, msg: m(5), checks: PASS_CHECKS, score: 98 });
  s.push({
    delay: 1300,
    agents: { verifier: "IDLE", lead: "STEERING" },
    msg: m(6),
    tasks: { "TASK-3": { status: "done", note: "@lead packaged release → done" } },
  });
  s.push({ delay: 800, agents: { lead: "IDLE" } });
  return s;
}

const percentile = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

export function Studio() {
  const [prompt, setPrompt] = useState(PRESETS[0]!);
  const [messages, setMessages] = useState<Message[]>(DEMO_MESSAGES);
  const [tasks, setTasks] = useState<Task[]>(DEMO_TASKS);
  const [files, setFiles] = useState<Record<string, string>>(DEMO_FILES);
  const [agentState, setAgentState] = useState<Record<AgentId, AgentState>>({
    architect: "IDLE",
    builder: "IDLE",
    verifier: "IDLE",
    lead: "IDLE",
  });
  const [checks, setChecks] = useState<Check[]>(PASS_CHECKS);
  const [sandboxStdout, setSandboxStdout] = useState<string>("ALL TESTS PASSED (5/5)");
  const [score, setScore] = useState(98);
  const [rubricBreakdown, setRubricBreakdown] = useState<Record<string, number> | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("preview");
  const [apiKey, setApiKey] = useState("");
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendHasKey, setBackendHasKey] = useState(false);
  const [backendTelemetry, setBackendTelemetry] = useState<any>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAsk, setShowAsk] = useState(false);
  const [retries, setRetries] = useState(0);
  const [error, setError] = useState("");
  const [session, setSession] = useState("sprint-priority-engine-8z24");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const hydrateFromBackendSession = useCallback((s: any, tel?: any) => {
    if (!s) return;
    setActiveSessionId(s.id);
    setSession(s.slug ? `${s.slug}-${s.id.slice(-4)}` : s.id);
    if (s.status === "running") {
      setRunning(true);
    } else if (s.status === "completed" || s.status === "error") {
      setRunning(false);
      setAgentState({ architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" });
    }

    if (Array.isArray(s.messages) && s.messages.length > 0) {
      setMessages(s.messages.map((m: any, idx: number) => mapBackendMessage(m, idx)));
    }
    if (Array.isArray(s.kanban) && s.kanban.length > 0) {
      setTasks(s.kanban.map((t: any) => mapBackendTask(t)));
    }
    if (Array.isArray(s.files) && s.files.length > 0) {
      const nextFiles: Record<string, string> = { ...DEMO_FILES };
      for (const f of s.files) {
        if (f && f.path && typeof f.content === "string") {
          nextFiles[f.path] = f.content;
        }
      }
      nextFiles[".cursor/mcp.json"] = MCP_JSON;
      setFiles(nextFiles);
    }
    if (Array.isArray(s.verificationRuns) && s.verificationRuns.length > 0) {
      const lastVer = s.verificationRuns[s.verificationRuns.length - 1];
      if (lastVer && Array.isArray(lastVer.checks)) {
        setChecks(lastVer.checks.map((c: any) => ({ name: c.name, ok: Boolean(c.passed) })));
      }
      if (lastVer?.stdout || lastVer?.stderr) {
        setSandboxStdout((lastVer.stdout || lastVer.stderr || "").trim());
      }
    }
    if (s.rubricEvaluation) {
      if (typeof s.rubricEvaluation.qualityScore === "number") {
        setScore(s.rubricEvaluation.qualityScore);
      }
      if (s.rubricEvaluation.rubric) {
        setRubricBreakdown(s.rubricEvaluation.rubric);
      }
    } else if (s.benchmark?.rubric?.qualityScore) {
      setScore(s.benchmark.rubric.qualityScore);
    }
    if (tel) {
      setBackendTelemetry(tel);
      if (typeof tel.retryCount === "number") setRetries(tel.retryCount);
    }
  }, []);

  const fetchBackendStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) return false;
      const data = await res.json();
      setBackendConnected(true);
      setBackendHasKey(Boolean(data.telemetry?.hasApiKey));
      if (data.telemetry) {
        setBackendTelemetry(data.telemetry);
      }
      if (Array.isArray(data.sessions) && data.sessions.length > 0) {
        const latest =
          data.sessions.find((s: any) => s.id === data.activeSessionId) ||
          data.sessions[data.sessions.length - 1];
        hydrateFromBackendSession(latest, data.telemetry);
      }
      return true;
    } catch {
      return false;
    }
  }, [hydrateFromBackendSession]);

  useEffect(() => {
    setApiKey(localStorage.getItem("BASETEN_API_KEY") ?? "");
    fetchBackendStatus();
  }, [fetchBackendStatus]);

  // Connect to live backend SSE stream (/api/events)
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/events");
      es.onmessage = (evt) => {
        try {
          const ev = JSON.parse(evt.data);
          setBackendConnected(true);
          if (ev.telemetry) {
            setBackendTelemetry(ev.telemetry);
            setBackendHasKey(Boolean(ev.telemetry.hasApiKey));
          }
          if (ev.eventType === "agent_active" && ev.agentId) {
            const aid = normalizeAgentId(ev.agentId);
            setAgentState({
              architect: aid === "architect" ? "THINKING" : "IDLE",
              builder: aid === "builder" ? "THINKING" : "IDLE",
              verifier: aid === "verifier" ? "TESTING" : "IDLE",
              lead: aid === "lead" ? "THINKING" : "IDLE",
            });
          } else if (ev.eventType === "bot_message" && ev.message) {
            const mapped = mapBackendMessage(ev.message, Date.now());
            setAgentState((prev) => ({ ...prev, [mapped.from]: "STEERING" }));
            setMessages((prev) => {
              if (prev.some((x) => x.id === mapped.id)) return prev;
              return [...prev, mapped];
            });
          } else if (ev.eventType === "kanban_created" && ev.task) {
            const mappedTask = mapBackendTask(ev.task);
            setTasks((prev) => {
              const exists = prev.some((t) => t.id === mappedTask.id);
              return exists
                ? prev.map((t) => (t.id === mappedTask.id ? mappedTask : t))
                : [...prev, mappedTask];
            });
          } else if (ev.eventType === "kanban_updated" && ev.task) {
            const mappedTask = mapBackendTask(ev.task);
            setTasks((prev) => prev.map((t) => (t.id === mappedTask.id ? mappedTask : t)));
          } else if (ev.eventType === "verification_run" && ev.results) {
            const r = ev.results;
            if (Array.isArray(r.checks)) {
              setChecks(r.checks.map((c: any) => ({ name: c.name, ok: Boolean(c.passed) })));
            }
            if (r.stdout || r.stderr) {
              setSandboxStdout((r.stdout || r.stderr || "").trim());
            }
            setScore(r.passed ? 98 : 61);
          } else if (ev.eventType === "session_completed" && ev.session) {
            hydrateFromBackendSession(ev.session, ev.telemetry);
            setRunning(false);
            setAgentState({ architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" });
          } else if (ev.eventType === "session_error") {
            setError(ev.error || "Swarm execution error");
            setRunning(false);
            setAgentState({ architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" });
          } else if (ev.eventType === "file_written") {
            fetchBackendStatus();
          }
        } catch {
          // ignore malformed SSE packet
        }
      };
    } catch {
      // SSE unavailable
    }
    return () => {
      es?.close();
    };
  }, [fetchBackendStatus, hydrateFromBackendSession]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const live = backendHasKey || apiKey.length > 0;
  const msgTokens = messages.reduce((a, m) => a + m.tokens, 0);
  const tokens =
    backendTelemetry?.totalTokensUsed > 0 ? backendTelemetry.totalTokensUsed : msgTokens;
  const reasoningTokens =
    backendTelemetry?.totalReasoningTokens > 0
      ? backendTelemetry.totalReasoningTokens
      : Math.round(tokens * 0.488);
  const lat = messages.map((m) => m.latency);
  const p50Sec =
    backendTelemetry?.p50LatencyMs > 0
      ? backendTelemetry.p50LatencyMs / 1000
      : percentile(lat, 0.5);
  const p95Sec =
    backendTelemetry?.p95LatencyMs > 0
      ? backendTelemetry.p95LatencyMs / 1000
      : percentile(lat, 0.95);
  const totalCalls =
    backendTelemetry?.totalCalls > 0 ? backendTelemetry.totalCalls : messages.length;

  const perAgent = useMemo(() => {
    const o: Record<string, { tokens: number; calls: number }> = {};
    AGENTS.forEach((a) => (o[a.id] = { tokens: 0, calls: 0 }));
    if (backendTelemetry?.agentBreakdown && Object.keys(backendTelemetry.agentBreakdown).length > 0) {
      for (const a of AGENTS) {
        const bd = backendTelemetry.agentBreakdown[a.id];
        if (bd) {
          o[a.id] = { tokens: bd.totalTokens || 0, calls: bd.calls || 0 };
        }
      }
      return o;
    }
    messages.forEach((m) => {
      if (o[m.from]) {
        o[m.from]!.tokens += m.tokens;
        o[m.from]!.calls += 1;
      }
    });
    return o;
  }, [messages, backendTelemetry]);

  const verdict =
    score >= 90 && checks.every((c) => c.ok) ? "VERIFIED_PASS" : running ? "RUNNING" : "FAIL";

  const fileTabs = useMemo(() => Object.keys(files), [files]);

  const previewHtml = useMemo(() => {
    const rawHtml = files["index.html"] || INDEX_HTML;
    const rawApp = files["app.js"] || APP_JS;
    if (rawHtml.includes("__APP__")) {
      return rawHtml.replace("__APP__", rawApp);
    }
    if (rawHtml.includes('<script src="app.js"></script>')) {
      return rawHtml.replace('<script src="app.js"></script>', `<script>\n${rawApp}\n</script>`);
    }
    return rawHtml;
  }, [files]);

  async function run(broken: boolean) {
    if (running) return;
    setRunning(true);
    setError("");
    setRetries(0);
    setMessages([]);
    setChecks([]);
    setScore(0);
    setTasks(DEMO_TASKS.map((t) => ({ ...t, status: "ready", audit: ["@architect initializing…"] })));

    if (backendConnected) {
      try {
        const res = await fetch("/api/swarm/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, simulateBrokenFirstPass: broken }),
        });
        if (!res.ok) {
          throw new Error(`Backend HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.session) {
          setActiveSessionId(data.session.id);
          setSession(
            data.session.slug
              ? `${data.session.slug}-${data.session.id.slice(-4)}`
              : data.session.id,
          );
        }
        return;
      } catch (e) {
        setError(`Backend unreachable (${(e as Error).message}) — running local step simulation.`);
      }
    }

    // Fallback step simulation when backend is offline
    setSession(
      `${prompt
        .split(" ")
        .slice(2, 5)
        .join("-")
        .toLowerCase()
        .replace(/[^a-z-]/g, "")}-${Math.random().toString(36).slice(2, 6)}`,
    );
    for (const step of buildSteps(broken)) {
      await new Promise((r) => setTimeout(r, step.delay));
      if (step.agents) setAgentState((s) => ({ ...s, ...step.agents }));
      if (step.tasks) {
        setTasks((ts) =>
          ts.map((t) => {
            const u = step.tasks![t.id];
            if (!u) return t;
            const { note, ...rest } = u;
            return { ...t, ...rest, audit: note ? [...t.audit, note] : t.audit };
          }),
        );
      }
      if (step.checks) setChecks(step.checks);
      if (step.score !== undefined) setScore(step.score);
      if (step.msg) {
        setMessages((ms) => [...ms, step.msg!]);
      }
    }
    setRunning(false);
  }

  async function sendAsk(to: AgentId, text: string) {
    setAgentState((s) => ({ ...s, [to]: "THINKING" }));
    if (backendConnected) {
      try {
        const res = await fetch("/api/swarm/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: to,
            message: text,
            sessionId: activeSessionId,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const replyMsg: Message = {
          id: data.message?.id || `ask-${Date.now()}`,
          from: to,
          to: "all",
          kind: "NOTIFY",
          text: data.reply || "Ack.",
          reasoning: data.reasoning || "(reasoning completed)",
          tokens: data.usage?.totalTokens || 640,
          latency: data.latencyMs ? Number((data.latencyMs / 1000).toFixed(1)) : 1.8,
        };
        setMessages((prev) =>
          prev.some((m) => m.id === replyMsg.id) ? prev : [...prev, replyMsg],
        );
        if (data.telemetry) {
          setBackendTelemetry(data.telemetry);
        }
        setAgentState((s) => ({ ...s, [to]: "IDLE" }));
        return;
      } catch (e) {
        setError((e as Error).message);
      }
    }

    const reply: Message = {
      id: `ask-${Date.now()}`,
      from: to,
      to: "all",
      kind: "NOTIFY",
      text: `Ack. Re: “${text.slice(0, 80)}” — I'll factor this into the current runbook and update the board.`,
      reasoning:
        "A human steer arrived on the bus. Acknowledge, scope it against active tasks, and avoid breaking dependencies.",
      tokens: 640,
      latency: 2.4,
    };
    setTimeout(() => {
      setMessages((m) => [...m, reply]);
      setAgentState((s) => ({ ...s, [to]: "IDLE" }));
    }, 900);
  }

  return (
    <div className="min-h-screen px-4 pb-10 pt-4 md:px-6">
      {/* Header */}
      <header className="glass sticky top-3 z-20 mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid size-9 grid-cols-2 gap-0.5 rounded-xl bg-secondary p-1.5">
            {(["architect", "builder", "verifier", "lead"] as AgentId[]).map((a) => (
              <span key={a} className={`rounded-full ${AGENT_BG[a]}`} />
            ))}
          </div>
          <div>
            <h1 className="headline text-[15px] leading-tight">MuseSwarm Studio</h1>
            <p className="text-[11px] text-muted-foreground">
              Multi-Agent Co-Builder · Meta Muse Spark Open
            </p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          <Pill>
            <span className={`size-1.5 rounded-full ${live ? "bg-builder" : "bg-verifier"}`} />
            {MODEL} · {live ? "LIVE BASETEN" : "DEMO SIMULATION"}
          </Pill>
          <Pill>
            <span className="tabular-nums">
              {tokens.toLocaleString()} / {TPM_LIMIT.toLocaleString()} TPM (
              {((tokens / TPM_LIMIT) * 100).toFixed(2)}%)
            </span>
            <span className="h-1 w-14 overflow-hidden rounded-full bg-secondary">
              <span
                className="block h-full rounded-full bg-telemetry transition-all duration-700"
                style={{ width: `${Math.max(2, (tokens / TPM_LIMIT) * 100 * 20)}%` }}
              />
            </span>
          </Pill>
          <Pill className="hidden tabular-nums lg:inline-flex">
            p50 {p50Sec.toFixed(1)}s · p95 {p95Sec.toFixed(1)}s · Reasoning{" "}
            {reasoningTokens.toLocaleString()} · Calls {totalCalls} · Retries {retries}
          </Pill>
          <Pill
            className={
              verdict === "VERIFIED_PASS"
                ? "text-builder"
                : verdict === "FAIL"
                  ? "text-destructive"
                  : "text-verifier"
            }
          >
            <b className="tabular-nums">{score}/100</b> {verdict}
          </Pill>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-full bg-secondary px-3 py-1.5 font-medium transition hover:bg-accent"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Prompt bar */}
      <section className="glass mx-auto mt-4 max-w-[1600px] rounded-2xl p-4">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p, i) => (
            <button
              key={i}
              onClick={() => setPrompt(p)}
              className={`rounded-full px-3 py-1 text-[11px] transition ${
                prompt === p
                  ? "bg-foreground text-background"
                  : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.split(" with ")[0]!.replace("Build a ", "").replace("Build an ", "")}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3 lg:flex-row">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            className="flex-1 resize-none rounded-xl bg-input px-3.5 py-2.5 text-sm outline-none ring-primary/50 focus:ring-2"
          />
          <div className="flex flex-wrap gap-2 lg:flex-col">
            <button
              disabled={running}
              onClick={() => run(false)}
              className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
            >
              {running ? "Swarm running…" : "Run Swarm Co-Build"}
            </button>
            <div className="flex gap-2">
              <button
                disabled={running}
                onClick={() => run(true)}
                className="rounded-full bg-secondary px-4 py-2 text-xs font-medium transition hover:bg-accent disabled:opacity-50"
              >
                Simulate Broken Build → Self-Heal
              </button>
              <button
                onClick={() => setShowAsk(true)}
                className="rounded-full bg-secondary px-4 py-2 text-xs font-medium text-architect transition hover:bg-accent"
              >
                Ask @architect
              </button>
            </div>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </section>

      {/* Grid */}
      <main className="mx-auto mt-4 grid max-w-[1600px] gap-4 md:grid-cols-2 xl:grid-cols-[260px_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* A — roster */}
        <Panel title="Peer Agents" subtitle="Roster & toolsets">
          <div className="space-y-2.5">
            {AGENTS.map((a) => (
              <div key={a.id} className="rounded-xl bg-card/60 p-3">
                <div className="flex items-center justify-between">
                  <span className={`text-sm font-semibold ${AGENT_TEXT[a.id]}`}>@{a.id}</span>
                  <span
                    className={`flex items-center gap-1.5 text-[10px] font-medium ${
                      agentState[a.id] === "IDLE" ? "text-muted-foreground" : AGENT_TEXT[a.id]
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${AGENT_BG[a.id]} ${
                        agentState[a.id] !== "IDLE" ? "animate-pulse" : "opacity-40"
                      }`}
                    />
                    {agentState[a.id]}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{a.role}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {a.tools.map((t) => (
                    <span
                      key={t}
                      className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
                  {perAgent[a.id]!.tokens.toLocaleString()} tokens · {perAgent[a.id]!.calls} calls
                </p>
                <details className="mt-1.5 text-[11px]">
                  <summary className="cursor-pointer text-primary">SOUL.md</summary>
                  <pre className="mt-1.5 whitespace-pre-wrap rounded-lg bg-background/60 p-2 font-mono text-[10px] text-muted-foreground">
                    {a.soul}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        </Panel>

        {/* B — kanban */}
        <Panel title="Kanban" subtitle="Dependency-aware · auditable">
          <div className="space-y-2.5">
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl bg-card/60 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-muted-foreground">{t.id}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[t.status]}`}
                  >
                    {t.status}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium">{t.title}</p>
                <div className="mt-2 flex items-center gap-2 text-[11px]">
                  <span className={AGENT_TEXT[t.assignee]}>@{t.assignee}</span>
                  {t.dependsOn.length > 0 && (
                    <span className="text-muted-foreground">↳ {t.dependsOn.join(", ")}</span>
                  )}
                </div>
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-primary">
                    Audit trail ({t.audit.length})
                  </summary>
                  <ol className="mt-1.5 space-y-1 border-l border-border pl-3 text-muted-foreground">
                    {t.audit.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ol>
                </details>
              </div>
            ))}
          </div>
        </Panel>

        {/* C — message bus */}
        <Panel title="Session Bus" subtitle={session}>
          <div
            ref={feedRef}
            className="hairline-scroll max-h-[640px] space-y-2.5 overflow-y-auto pr-1"
          >
            {messages.length === 0 && (
              <p className="py-10 text-center text-xs text-muted-foreground">
                Waiting for @architect…
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className="animate-in fade-in slide-in-from-bottom-2 rounded-xl bg-card/60 p-3 duration-500"
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={`font-semibold ${AGENT_TEXT[m.from]}`}>@{m.from}</span>
                  <span className="text-muted-foreground">→</span>
                  <span
                    className={
                      m.to === "all" ? "font-semibold" : `font-semibold ${AGENT_TEXT[m.to]}`
                    }
                  >
                    @{m.to}
                  </span>
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-[9px] font-semibold ${KIND_STYLE[m.kind]}`}
                  >
                    {m.kind}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed">{m.text}</p>
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">
                    Internal reasoning <code className="font-mono">reasoning_content</code>
                  </summary>
                  <p className="mt-1.5 rounded-lg bg-background/60 p-2 italic text-muted-foreground">
                    {m.reasoning}
                  </p>
                </details>
                <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {m.tokens.toLocaleString()} tok · {m.latency.toFixed(1)}s
                </p>
              </div>
            ))}
          </div>
        </Panel>

        {/* D — inspector */}
        <Panel title="Inspector" subtitle="Artifacts · sandbox · preview">
          <div className="hairline-scroll -mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-1">
            {(
              [
                ["preview", "Live App"],
                ["rubric", "Verification"],
                ["mcp", "Cursor & CLI"],
                ...fileTabs.map((f) => [f, f]),
              ] as [string, string][]
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`shrink-0 rounded-full px-3 py-1 text-[11px] transition ${
                  tab === k
                    ? "bg-foreground text-background"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          {tab === "preview" && (
            <iframe
              title="Live app preview"
              sandbox="allow-scripts allow-forms"
              srcDoc={previewHtml}
              className="h-[560px] w-full rounded-xl border border-border bg-background"
            />
          )}
          {tab === "rubric" && (
            <Rubric
              checks={checks}
              score={score}
              verdict={verdict}
              sandboxStdout={sandboxStdout}
              rubricBreakdown={rubricBreakdown}
              testJs={files["test.js"] || TEST_JS}
            />
          )}
          {tab === "mcp" && (
            <div className="space-y-3">
              <Code title=".cursor/mcp.json" body={MCP_JSON} />
              <Code
                title="Terminal"
                body={
                  "$ muse-swarm doctor\n$ muse-swarm peers\n$ muse-swarm run --demo\n$ muse-swarm benchmark"
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Follows Muse Code CLI conventions: AGENTS.md, .agents/memory/, .muse/hooks.json
              </p>
            </div>
          )}
          {fileTabs.includes(tab) && <Code title={tab} body={files[tab] ?? ""} />}
        </Panel>
      </main>

      {showSettings && (
        <Modal onClose={() => setShowSettings(false)} title="Baseten & MuseSwarm Connection">
          <p className="mb-3 text-xs text-muted-foreground">
            {backendHasKey
              ? "Connected to local MuseSwarm server with live BASETEN_API_KEY configured in .env."
              : "Paste an optional BASETEN_API_KEY override or leave empty to use the server .env configuration."}
          </p>
          <input
            type="password"
            defaultValue={apiKey}
            id="bk"
            placeholder={backendHasKey ? "Configured via server .env (LIVE BASETEN)" : "BASETEN_API_KEY"}
            className="w-full rounded-xl bg-input px-3 py-2.5 text-sm outline-none ring-primary/50 focus:ring-2"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => {
                localStorage.removeItem("BASETEN_API_KEY");
                setApiKey("");
                setShowSettings(false);
              }}
              className="rounded-full bg-secondary px-4 py-2 text-xs"
            >
              Use Server Default
            </button>
            <button
              onClick={() => {
                const v = (document.getElementById("bk") as HTMLInputElement).value.trim();
                localStorage.setItem("BASETEN_API_KEY", v);
                setApiKey(v);
                setShowSettings(false);
              }}
              className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
            >
              Save
            </button>
          </div>
        </Modal>
      )}
      {showAsk && (
        <AskModal
          onClose={() => setShowAsk(false)}
          onSend={(to, t) => {
            sendAsk(to, t);
            setShowAsk(false);
          }}
        />
      )}
    </div>
  );
}

function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full bg-secondary/70 px-2.5 py-1.5 font-medium ${className}`}
    >
      {children}
    </span>
  );
}
function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="glass min-w-0 rounded-2xl p-4">
      <div className="mb-3">
        <h2 className="headline text-[17px]">{title}</h2>
        <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}
function Code({ title, body }: { title: string; body: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background/70">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">{title}</span>
        <button onClick={() => navigator.clipboard.writeText(body)} className="text-primary">
          Copy
        </button>
      </div>
      <pre className="hairline-scroll max-h-[500px] overflow-auto p-3 font-mono text-[11px] leading-relaxed">
        {body}
      </pre>
    </div>
  );
}
function Rubric({
  checks,
  score,
  verdict,
  sandboxStdout,
  rubricBreakdown,
  testJs,
}: {
  checks: Check[];
  score: number;
  verdict: string;
  sandboxStdout: string;
  rubricBreakdown: Record<string, number> | null;
  testJs: string;
}) {
  const parts: [string, number][] = rubricBreakdown
    ? [
        ["Correctness", rubricBreakdown["correctness"] ?? 25],
        ["Test Coverage", rubricBreakdown["testCoverage"] ?? 24],
        ["Architecture Adherence", rubricBreakdown["architectureAdherence"] ?? 25],
        ["UI Completeness", rubricBreakdown["uiCompleteness"] ?? 24],
      ]
    : score >= 90
      ? [
          ["Correctness", 25],
          ["Test Coverage", 24],
          ["Architecture Adherence", 25],
          ["UI Completeness", 24],
        ]
      : score > 0
        ? [
            ["Correctness", 12],
            ["Test Coverage", 18],
            ["Architecture Adherence", 23],
            ["UI Completeness", 8],
          ]
        : [];
  const allPass = checks.length > 0 && checks.every((c) => c.ok);
  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="headline text-5xl tabular-nums">
          {score}
          <span className="text-xl text-muted-foreground">/100</span>
        </p>
        <p
          className={`mt-1 text-xs font-semibold ${
            verdict === "VERIFIED_PASS" ? "text-builder" : "text-verifier"
          }`}
        >
          {verdict}
        </p>
      </div>
      <div className="divide-y divide-border rounded-xl bg-card/60">
        {checks.map((c) => (
          <div key={c.name} className="flex justify-between px-3 py-2 text-xs">
            <span className="font-mono">{c.name}</span>
            <span className={c.ok ? "text-builder" : "text-destructive"}>
              {c.ok ? "✓ pass" : "✗ fail"}
            </span>
          </div>
        ))}
        {checks.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">Sandbox idle…</p>
        )}
      </div>
      <pre className="whitespace-pre-wrap rounded-xl bg-background/70 p-3 font-mono text-[11px] text-muted-foreground">
        $ node --check app.js && node --check test.js && node test.js{"\n"}
        {sandboxStdout ||
          (allPass
            ? "ALL TESTS PASSED (5/5)"
            : checks.some((c) => !c.ok)
              ? "AssertionError [ERR_ASSERTION]"
              : "…")}
      </pre>
      <div className="space-y-2">
        {parts.map(([k, v]) => (
          <div key={k}>
            <div className="flex justify-between text-xs">
              <span>{k}</span>
              <span className="tabular-nums text-muted-foreground">{v}/25</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all duration-700"
                style={{ width: `${(v / 25) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-primary">test.js</summary>
        <pre className="mt-2 overflow-auto rounded-lg bg-background/70 p-2 font-mono">{testJs}</pre>
      </details>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="animate-in fade-in fixed inset-0 z-50 grid place-items-center bg-background/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass animate-in zoom-in-95 w-full max-w-md rounded-2xl bg-glass-strong p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="headline mb-2 text-lg">{title}</h3>
        {children}
      </div>
    </div>
  );
}
function AskModal({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (to: AgentId, t: string) => void;
}) {
  const [to, setTo] = useState<AgentId>("architect");
  const [text, setText] = useState("");
  return (
    <Modal title="Send a steer message" onClose={onClose}>
      <div className="mb-3 flex gap-1.5">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setTo(a.id)}
            className={`rounded-full px-3 py-1 text-xs ${
              to === a.id ? `bg-secondary font-semibold ${AGENT_TEXT[a.id]}` : "text-muted-foreground"
            }`}
          >
            @{a.id}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="e.g. Add a tiebreak rule for equal scores"
        className="w-full resize-none rounded-xl bg-input px-3 py-2.5 text-sm outline-none ring-primary/50 focus:ring-2"
      />
      <div className="mt-4 flex justify-end">
        <button
          disabled={!text.trim()}
          onClick={() => onSend(to, text)}
          className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Send STEER
        </button>
      </div>
    </Modal>
  );
}
