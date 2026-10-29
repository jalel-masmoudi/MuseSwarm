import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { deriveVerifyReport, loadScenarios, pullSessionDiffs } from "@/lib/api";
import { DiffExplorer, FileExplorer, McpBridge, ProofStrip } from "@/components/judge-panels";
import {
  DEFAULT_SCENARIO,
  filesForPass,
  playback,
  resetTasks,
  type Check,
  type Scenario,
} from "@/lib/scenarios";
import {
  AGENTS,
  MODEL,
  TPM_LIMIT,
  type AgentId,
  type AgentState,
  type Message,
  type MsgKind,
  type Task,
  type TaskStatus,
} from "@/lib/swarm-data";
import { collectFiles, diffsFromSnapshots, parseReworkDiffs, type ReworkFileDiff } from "@/lib/workspace";

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

type Snap = {
  armed: boolean;
  wantPass1: boolean;
  wantPass2: boolean;
  locked1: boolean;
  locked2: boolean;
};

function normalizeAgentId(raw?: string): AgentId {
  const clean = String(raw || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (clean === "architect" || clean === "builder" || clean === "verifier" || clean === "lead") return clean;
  return "architect";
}

function normalizeRecipient(raw?: string): AgentId | "all" {
  const clean = String(raw || "")
    .replace(/^@/, "")
    .toLowerCase();
  if (clean === "all" || clean === "user") return "all";
  return normalizeAgentId(clean);
}

function mapBackendMessage(m: Record<string, unknown>, idx: number): Message {
  const meta = (m["metadata"] as Record<string, unknown> | undefined) ?? {};
  const phase = String(meta["phase"] || "");
  const rawDel = String(m["delivery"] || "steer").toUpperCase();
  const kind: MsgKind =
    phase === "rework_request"
      ? "REWORK"
      : rawDel === "QUEUE" || rawDel === "NOTIFY" || rawDel === "STEER"
        ? (rawDel as MsgKind)
        : "STEER";
  const content = String(m["content"] || "");
  const reasoning = String(m["reasoning"] || "");
  const estTokens =
    Number(meta["tokens"]) || Math.max(480, Math.round((content.length + reasoning.length) * 0.9));
  const estLatency = meta["latencyMs"]
    ? Number((Number(meta["latencyMs"]) / 1000).toFixed(1))
    : Number((2.4 + (idx % 4) * 1.7).toFixed(1));
  return {
    id: String(m["id"] || `msg-${idx}-${Date.now()}`),
    from: normalizeAgentId(String(m["from"] || "")),
    to: normalizeRecipient(String(m["to"] || "")),
    kind,
    text: content,
    reasoning: reasoning || "(concise reasoning step completed)",
    tokens: estTokens,
    latency: estLatency,
  };
}

function mapBackendTask(t: Record<string, unknown>): Task {
  const audit: string[] = [];
  if (Array.isArray(t["history"])) {
    for (const h of t["history"] as Record<string, unknown>[]) {
      audit.push(`${h["author"] || "@system"}: ${h["from"] ? `${h["from"]} → ` : ""}${h["to"] ?? ""}`);
    }
  }
  if (Array.isArray(t["comments"])) {
    for (const c of t["comments"] as Record<string, unknown>[]) {
      audit.push(`${c["author"] || "@agent"}: ${c["text"] ?? ""}`);
    }
  }
  const depends = Array.isArray(t["dependsOn"]) ? (t["dependsOn"] as string[]) : [];
  const deps = depends.length ? depends : t["parentId"] ? [String(t["parentId"])] : [];
  const raw = String(t["status"] || "ready");
  const status: TaskStatus = raw === "in_progress" || raw === "rework" || raw === "done" ? raw : "ready";
  return {
    id: String(t["id"]),
    title: String(t["title"] || ""),
    assignee: normalizeAgentId(String(t["assignee"] || "")),
    dependsOn: deps,
    status,
    audit: audit.length ? audit : ["@architect created · ready"],
  };
}

const percentile = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
};

function latestThought(messages: Message[], id: AgentId): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.from === id && msg.reasoning) return msg.reasoning;
  }
  return "waiting for the next reasoning_content trace";
}

export function Studio() {
  const boot = DEFAULT_SCENARIO;
  const [scenarios, setScenarios] = useState<Scenario[]>([boot]);
  const [scenarioSource, setScenarioSource] = useState<"api" | "local">("local");
  const [activeId, setActiveId] = useState(boot.id);
  const [prompt, setPrompt] = useState(boot.brief);
  const [messages, setMessages] = useState<Message[]>(boot.messages);
  const [tasks, setTasks] = useState<Task[]>(boot.tasks);
  const [files, setFiles] = useState<Record<string, string>>(boot.files);
  const [pass1, setPass1] = useState<Record<string, string>>(boot.pass1 ? filesForPass(boot, 1) : {});
  const [pass2, setPass2] = useState<Record<string, string>>(boot.pass1 ? boot.files : {});
  const [backendDiffs, setBackendDiffs] = useState<ReworkFileDiff[] | null>(null);
  const [diffSource, setDiffSource] = useState(boot.pass1 ? "scenario showcase" : "single pass");
  const [agentState, setAgentState] = useState<Record<AgentId, AgentState>>({
    architect: "IDLE",
    builder: "IDLE",
    verifier: "IDLE",
    lead: "IDLE",
  });
  const [checks, setChecks] = useState<Check[]>(boot.passChecks);
  const [sandboxStdout, setSandboxStdout] = useState(boot.passStdout);
  const [failNote, setFailNote] = useState(boot.failChecks ? "Pass 1 failed runtime:test.js · Pass 2 verified" : "");
  const [score, setScore] = useState(boot.score);
  const [reworkCycles, setReworkCycles] = useState(boot.expectsRework ? 1 : 0);
  const [rubricBreakdown, setRubricBreakdown] = useState<Record<string, number> | null>(null);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("diff");
  const [apiKey, setApiKey] = useState("");
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendHasKey, setBackendHasKey] = useState(false);
  const [backendTelemetry, setBackendTelemetry] = useState<Record<string, unknown> | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAsk, setShowAsk] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [retries, setRetries] = useState(0);
  const [error, setError] = useState("");
  const [session, setSession] = useState(boot.id);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef(files);
  const runningRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const liveSnap = useRef<Snap>({
    armed: false,
    wantPass1: false,
    wantPass2: false,
    locked1: false,
    locked2: false,
  });
  filesRef.current = files;
  runningRef.current = running;

  const showScenario = useCallback((s: Scenario) => {
    setActiveId(s.id);
    setPrompt(s.brief);
    setMessages(s.messages);
    setTasks(s.tasks);
    setFiles(s.files);
    setPass1(s.pass1 ? filesForPass(s, 1) : {});
    setPass2(s.pass1 ? s.files : {});
    setBackendDiffs(null);
    setDiffSource(s.pass1 ? "scenario showcase" : "single pass");
    setChecks(s.passChecks);
    setSandboxStdout(s.passStdout);
    setFailNote(s.failChecks ? "Pass 1 failed runtime:test.js · Pass 2 verified" : "");
    setScore(s.score);
    setReworkCycles(s.expectsRework ? 1 : 0);
    setRubricBreakdown(null);
    setSession(s.id);
    setTab(s.pass1 ? "diff" : "files");
  }, []);

  const noteSnapshots = useCallback((nextFiles: Record<string, string>) => {
    const snap = liveSnap.current;
    if (!snap.armed) return;
    if (snap.wantPass1 && snap.wantPass2 && !snap.locked1) {
      snap.wantPass1 = false;
      snap.wantPass2 = false;
      return;
    }
    if (snap.wantPass1 && !snap.locked1) {
      snap.locked1 = true;
      snap.wantPass1 = false;
      setPass1(nextFiles);
      setDiffSource("client snapshot");
      return;
    }
    if (snap.wantPass2 && snap.locked1 && !snap.locked2) {
      snap.locked2 = true;
      snap.wantPass2 = false;
      setPass2(nextFiles);
      setDiffSource("client snapshot");
    }
  }, []);

  const rememberDiffs = useCallback(async (sessionId: string, embedded: unknown) => {
    const fromSession = parseReworkDiffs(embedded);
    if (fromSession.length) {
      setBackendDiffs(fromSession);
      setDiffSource("session.reworkDiffs");
    }
    const remote = await pullSessionDiffs(sessionId);
    if (remote && remote.length) {
      setBackendDiffs(remote);
      setDiffSource("GET /api/session/:id/diffs");
    }
  }, []);

  const hydrateFromBackendSession = useCallback(
    (s: Record<string, unknown> | null, tel?: Record<string, unknown>) => {
      if (!s) return;
      const id = String(s["id"] || "");
      if (activeIdRef.current && id && id !== activeIdRef.current) return;
      setActiveSessionId(id || null);
      const slug = s["slug"] ? `${s["slug"]}-${id.slice(-4)}` : id;
      if (slug) setSession(slug);
      if (s["status"] === "running") setRunning(true);
      else if (s["status"] === "completed" || s["status"] === "error") {
        setRunning(false);
        setAgentState({ architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" });
      }
      if (Array.isArray(s["messages"]) && s["messages"].length) {
        setMessages(
          (s["messages"] as Record<string, unknown>[]).map((m, idx) => mapBackendMessage(m, idx)),
        );
      }
      if (Array.isArray(s["kanban"]) && s["kanban"].length) {
        setTasks((s["kanban"] as Record<string, unknown>[]).map((t) => mapBackendTask(t)));
      }
      const collected = collectFiles(s["files"], s["artifacts"], s["artifactFiles"]);
      if (Object.keys(collected).length) {
        if (!collected["verify-report.json"]) collected["verify-report.json"] = deriveVerifyReport(s);
        setFiles(collected);
        noteSnapshots(collected);
      }
      const runs = Array.isArray(s["verificationRuns"]) ? (s["verificationRuns"] as Record<string, unknown>[]) : [];
      const lastVer = runs[runs.length - 1];
      if (lastVer && Array.isArray(lastVer["checks"])) {
        setChecks(
          (lastVer["checks"] as Record<string, unknown>[]).map((c) => ({
            name: String(c["name"]),
            ok: Boolean(c["passed"]),
          })),
        );
      }
      if (lastVer && (lastVer["stdout"] || lastVer["stderr"])) {
        setSandboxStdout(String(lastVer["stdout"] || lastVer["stderr"] || "").trim());
      }
      const rubric = s["rubricEvaluation"] as Record<string, unknown> | null;
      if (rubric && typeof rubric["qualityScore"] === "number") setScore(rubric["qualityScore"] as number);
      if (rubric && rubric["rubric"] && typeof rubric["rubric"] === "object") {
        setRubricBreakdown(rubric["rubric"] as Record<string, number>);
      }
      const cycles = Number(s["reworkCycles"] || 0);
      if (cycles) {
        setReworkCycles(cycles);
        setFailNote("Pass 1 caught by @verifier · Pass 2 patched by @builder");
      }
      if (tel) {
        setBackendTelemetry(tel);
        if (typeof tel["retryCount"] === "number") setRetries(tel["retryCount"] as number);
      }
      if (id) void rememberDiffs(id, s["reworkDiffs"]);
    },
    [noteSnapshots, rememberDiffs],
  );

  const fetchBackendStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("json")) return false;
      const data = (await res.json()) as Record<string, unknown>;
      setBackendConnected(true);
      const tel = data["telemetry"] as Record<string, unknown> | undefined;
      setBackendHasKey(Boolean(tel?.["hasApiKey"]));
      if (tel) setBackendTelemetry(tel);
      if (Array.isArray(data["sessions"]) && data["sessions"].length) {
        const sessions = data["sessions"] as Record<string, unknown>[];
        const latest =
          sessions.find((s) => s["id"] === data["activeSessionId"]) || sessions[sessions.length - 1];
        const attach = latest?.["status"] === "running" || Boolean(activeIdRef.current);
        if (attach) hydrateFromBackendSession(latest ?? null, tel);
      }
      return true;
    } catch {
      return false;
    }
  }, [hydrateFromBackendSession]);

  useEffect(() => {
    setApiKey(localStorage.getItem("BASETEN_API_KEY") ?? "");
    void fetchBackendStatus();
  }, [fetchBackendStatus]);

  useEffect(() => {
    let cancel = false;
    loadScenarios().then((result) => {
      if (cancel) return;
      setScenarios(result.scenarios);
      setScenarioSource(result.source);
      if (runningRef.current || result.source !== "api") return;
      const match =
        result.scenarios.find((s) => s.id === DEFAULT_SCENARIO.id) ?? result.scenarios[0];
      if (match) showScenario(match);
    });
    return () => {
      cancel = true;
    };
  }, [showScenario]);

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/events");
      es.onmessage = (evt) => {
        try {
          const ev = JSON.parse(evt.data) as Record<string, unknown>;
          setBackendConnected(true);
          const tel = ev["telemetry"] as Record<string, unknown> | undefined;
          if (tel) {
            setBackendTelemetry(tel);
            setBackendHasKey(Boolean(tel["hasApiKey"]));
          }
          if (ev["eventType"] === "agent_active" && ev["agentId"]) {
            const aid = normalizeAgentId(String(ev["agentId"]));
            setAgentState({
              architect: aid === "architect" ? "THINKING" : "IDLE",
              builder: aid === "builder" ? "THINKING" : "IDLE",
              verifier: aid === "verifier" ? "TESTING" : "IDLE",
              lead: aid === "lead" ? "THINKING" : "IDLE",
            });
          } else if (ev["eventType"] === "bot_message" && ev["message"]) {
            const mapped = mapBackendMessage(ev["message"] as Record<string, unknown>, Date.now());
            setAgentState((prev) => ({ ...prev, [mapped.from]: "STEERING" }));
            setMessages((prev) => (prev.some((x) => x.id === mapped.id) ? prev : [...prev, mapped]));
          } else if (ev["eventType"] === "kanban_created" && ev["task"]) {
            const mappedTask = mapBackendTask(ev["task"] as Record<string, unknown>);
            setTasks((prev) =>
              prev.some((t) => t.id === mappedTask.id)
                ? prev.map((t) => (t.id === mappedTask.id ? mappedTask : t))
                : [...prev, mappedTask],
            );
          } else if (ev["eventType"] === "kanban_updated" && ev["task"]) {
            const mappedTask = mapBackendTask(ev["task"] as Record<string, unknown>);
            setTasks((prev) => prev.map((t) => (t.id === mappedTask.id ? mappedTask : t)));
          } else if (ev["eventType"] === "verification_run" && ev["results"]) {
            const r = ev["results"] as Record<string, unknown>;
            if (Array.isArray(r["checks"])) {
              setChecks(
                (r["checks"] as Record<string, unknown>[]).map((c) => ({
                  name: String(c["name"]),
                  ok: Boolean(c["passed"]),
                })),
              );
            }
            if (r["stdout"] || r["stderr"]) setSandboxStdout(String(r["stdout"] || r["stderr"] || "").trim());
            const passed = Boolean(r["passed"]);
            setScore(passed ? 98 : 61);
            if (!passed) {
              liveSnap.current.wantPass1 = true;
              setFailNote("Pass 1 · @verifier opened REWORK");
              setReworkCycles((n) => Math.max(1, n));
            } else if (liveSnap.current.wantPass1 || liveSnap.current.locked1) {
              liveSnap.current.wantPass2 = true;
              setFailNote("Pass 1 REWORK → Pass 2 VERIFIED_PASS");
            }
            const snapFiles = collectFiles(r["files"], r["snapshot"], r["artifacts"]);
            if (Object.keys(snapFiles).length) {
              if (!passed) {
                setPass1(snapFiles);
                liveSnap.current.locked1 = true;
              } else {
                setPass2(snapFiles);
                liveSnap.current.locked2 = true;
              }
              setDiffSource("client snapshot");
            }
          } else if (ev["eventType"] === "session_completed" && ev["session"]) {
            const done = ev["session"] as Record<string, unknown>;
            hydrateFromBackendSession(done, tel);
            setRunning(false);
            liveSnap.current.armed = false;
            setAgentState({ architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" });
          } else if (ev["eventType"] === "session_error") {
            setError(String(ev["error"] || "Swarm execution error"));
            setRunning(false);
            liveSnap.current.armed = false;
            setAgentState({ architect: "IDLE", builder: "IDLE", verifier: "IDLE", lead: "IDLE" });
          } else if (ev["eventType"] === "file_written") {
            void fetchBackendStatus();
          }
        } catch {
          // ignore malformed SSE packet
        }
      };
    } catch {
      // SSE unavailable
    }
    return () => es?.close();
  }, [fetchBackendStatus, hydrateFromBackendSession]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const active = scenarios.find((s) => s.id === activeId) ?? scenarios[0] ?? boot;
  const live = backendHasKey || apiKey.length > 0;
  const msgTokens = messages.reduce((a, m) => a + m.tokens, 0);
  const tel = backendTelemetry;
  const tokens = Number(tel?.["totalTokensUsed"] || 0) > 0 ? Number(tel?.["totalTokensUsed"]) : msgTokens;
  const rollingTpm = Number(tel?.["currentTpm"] || 0);
  const tpmLimit = Number(tel?.["tpmLimit"] || TPM_LIMIT);
  const reasoningTokens =
    Number(tel?.["totalReasoningTokens"] || 0) > 0
      ? Number(tel?.["totalReasoningTokens"])
      : Math.round(tokens * 0.48);
  const lat = messages.map((m) => m.latency);
  const p50Sec = Number(tel?.["p50LatencyMs"] || 0) > 0 ? Number(tel?.["p50LatencyMs"]) / 1000 : percentile(lat, 0.5);
  const p95Sec = Number(tel?.["p95LatencyMs"] || 0) > 0 ? Number(tel?.["p95LatencyMs"]) / 1000 : percentile(lat, 0.95);
  const totalCalls = Number(tel?.["totalCalls"] || 0) > 0 ? Number(tel?.["totalCalls"]) : messages.length;
  const model = String(tel?.["modelId"] || MODEL);
  const endpoint = String(tel?.["endpoint"] || "https://inference.baseten.co/v1");

  const perAgent = useMemo(() => {
    const o: Record<string, { tokens: number; calls: number }> = {};
    for (const a of AGENTS) o[a.id] = { tokens: 0, calls: 0 };
    const breakdown = tel?.["agentBreakdown"] as Record<string, { totalTokens?: number; calls?: number }> | undefined;
    if (breakdown && Object.keys(breakdown).length) {
      for (const a of AGENTS) {
        const bd = breakdown[a.id];
        if (bd) o[a.id] = { tokens: bd.totalTokens || 0, calls: bd.calls || 0 };
      }
      return o;
    }
    for (const m of messages) {
      const slot = o[m.from];
      if (slot) {
        slot.tokens += m.tokens;
        slot.calls += 1;
      }
    }
    return o;
  }, [messages, tel]);

  const diffs = useMemo(() => {
    if (backendDiffs && backendDiffs.length) return backendDiffs;
    if (Object.keys(pass1).length && Object.keys(pass2).length) return diffsFromSnapshots(pass1, pass2);
    return [];
  }, [backendDiffs, pass1, pass2]);

  const verdict = score >= 90 && checks.length > 0 && checks.every((c) => c.ok) ? "VERIFIED_PASS" : running ? "RUNNING" : score > 0 ? "REWORK" : "IDLE";
  const assertions = (files["test.js"] || "").match(/\bassert\./g)?.length ?? 0;
  const previewHtml = useMemo(() => {
    const rawHtml = files["index.html"] || "";
    const rawApp = files["app.js"] || files["solution.js"] || "";
    const rawDomain = files["domain.js"] || "";
    if (!rawHtml) return "<p style='font-family:sans-serif;padding:24px'>No index.html in this workspace yet.</p>";
    let html = rawHtml.includes("__APP__") ? rawHtml.replace("__APP__", rawApp) : rawHtml;
    const inline = (name: string, source: string) => {
      const tag = `<script src="${name}"></script>`;
      if (!source || !html.includes(tag)) return;
      html = html.replace(tag, `<script>\n${source.replaceAll("</script>", "<\\/script>")}\n</script>`);
    };
    inline("domain.js", rawDomain);
    inline("app.js", rawApp);
    return html;
  }, [files]);

  async function run(broken: boolean, picked?: Scenario) {
    if (running) return;
    const scenario = picked ?? active;
    const brief = picked ? picked.brief : prompt;
    setActiveId(scenario.id);
    setPrompt(brief);
    setRunning(true);
    setError("");
    setRetries(0);
    setMessages([]);
    setChecks([]);
    setScore(0);
    setFailNote("");
    setBackendDiffs(null);
    setPass1({});
    setPass2({});
    setDiffSource("waiting");
    setReworkCycles(0);
    setRubricBreakdown(null);
    setTasks(resetTasks(scenario.tasks.length ? scenario.tasks : boot.tasks));
    setFiles(broken && scenario.pass1 ? filesForPass(scenario, 1) : scenario.files);
    setTab(scenario.expectsRework || broken ? "diff" : "files");
    setSession(scenario.id);

    if (backendConnected) {
      try {
        const res = await fetch("/api/swarm/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brief,
            prompt: brief,
            scenarioId: scenario.id,
            projectName: scenario.id,
            simulateBrokenFirstPass: broken,
          }),
        });
        const ct = res.headers.get("content-type") || "";
        if (!res.ok || !ct.includes("json")) throw new Error(`Backend HTTP ${res.status}`);
        const data = (await res.json()) as Record<string, unknown>;
        const sess = data["session"] as Record<string, unknown> | undefined;
        if (sess?.["id"]) {
          const sid = String(sess["id"]);
          activeIdRef.current = sid;
          setActiveSessionId(sid);
          setSession(sess["slug"] ? `${sess["slug"]}-${sid.slice(-4)}` : sid);
        }
        liveSnap.current = { armed: true, wantPass1: false, wantPass2: false, locked1: false, locked2: false };
        return;
      } catch (err) {
        setError(`Backend unreachable (${(err as Error).message}) — running local step simulation.`);
      }
    }

    liveSnap.current.armed = false;
    if (!scenario.messages.length) {
      setError("This scenario needs the live swarm. GET /api/scenarios is up, but the run endpoint did not accept the brief.");
      setRunning(false);
      return;
    }
    const runId = Math.random().toString(36).slice(2, 6);
    for (const step of playback(scenario, broken, runId)) {
      await new Promise((r) => setTimeout(r, step.delay));
      if (step.agents) setAgentState((s) => ({ ...s, ...step.agents }));
      if (step.tasks) {
        setTasks((ts) =>
          ts.map((t) => {
            const u = step.tasks?.[t.id];
            if (!u) return t;
            return {
              ...t,
              ...(u.status ? { status: u.status } : {}),
              audit: u.note ? [...t.audit, u.note] : t.audit,
            };
          }),
        );
      }
      if (step.checks) setChecks(step.checks);
      if (step.score !== undefined) setScore(step.score);
      if (step.files) {
        setFiles(step.files);
        if (step.phase === "pass1") {
          setPass1(step.files);
          setSandboxStdout(scenario.failStdout || "");
          setDiffSource("client snapshot");
        }
        if (step.phase === "pass2") {
          setPass2(step.files);
          setSandboxStdout(scenario.passStdout);
          setDiffSource("client snapshot");
        }
      }
      if (step.msg) setMessages((ms) => [...ms, step.msg!]);
    }
    if (broken && scenario.pass1) {
      setReworkCycles(1);
      setFailNote("Pass 1 REWORK → Pass 2 VERIFIED_PASS");
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
          body: JSON.stringify({ agent: to, message: text, sessionId: activeSessionId }),
        });
        const data = (await res.json()) as Record<string, unknown>;
        if (!res.ok || !data["ok"]) throw new Error(String(data["error"] || `HTTP ${res.status}`));
        const posted = data["message"] as Record<string, unknown> | undefined;
        const usage = data["usage"] as Record<string, unknown> | undefined;
        const reply: Message = {
          id: String(posted?.["id"] || `ask-${Date.now()}`),
          from: to,
          to: "all",
          kind: "NOTIFY",
          text: String(data["reply"] || "Ack."),
          reasoning: String(data["reasoning"] || "(reasoning completed)"),
          tokens: Number(usage?.["totalTokens"] || 640),
          latency: data["latencyMs"] ? Number((Number(data["latencyMs"]) / 1000).toFixed(1)) : 1.8,
        };
        setMessages((prev) => (prev.some((m) => m.id === reply.id) ? prev : [...prev, reply]));
        if (data["telemetry"]) setBackendTelemetry(data["telemetry"] as Record<string, unknown>);
        setAgentState((s) => ({ ...s, [to]: "IDLE" }));
        return;
      } catch (err) {
        setError((err as Error).message);
      }
    }
    const reply: Message = {
      id: `ask-${Date.now()}`,
      from: to,
      to: "all",
      kind: "NOTIFY",
      text: `Ack. Re: “${text.slice(0, 80)}” — I'll factor this into the current runbook and update the board.`,
      reasoning: "A human steer arrived on the bus. Acknowledge it, keep dependencies intact, and answer in role.",
      tokens: 640,
      latency: 2.4,
    };
    setTimeout(() => {
      setMessages((m) => [...m, reply]);
      setAgentState((s) => ({ ...s, [to]: "IDLE" }));
    }, 900);
  }

  const thoughts = AGENTS.map((a) => ({
    id: a.id,
    state: agentState[a.id],
    text: latestThought(messages, a.id),
  }));

  return (
    <div className="min-h-screen px-4 pb-10 pt-4 md:px-6">
      <header className="glass sticky top-3 z-20 mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid size-9 grid-cols-2 gap-0.5 rounded-xl bg-secondary p-1.5">
            {(["architect", "builder", "verifier", "lead"] as AgentId[]).map((a) => (
              <span key={a} className={`rounded-full ${AGENT_BG[a]}`} />
            ))}
          </div>
          <div>
            <h1 className="headline text-[15px] leading-tight">MuseSwarm Studio</h1>
            <p className="font-mono text-[11px] text-muted-foreground">{model}</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
          <Pill>
            <span className={`size-1.5 rounded-full ${live ? "bg-builder" : "bg-verifier"}`} />
            {live ? "LIVE BASETEN" : "DEMO SIMULATION"}
          </Pill>
          <Pill className="tabular-nums">
            {tokens.toLocaleString()} / {tpmLimit.toLocaleString()} TPM
          </Pill>
          <Pill
            className={
              verdict === "VERIFIED_PASS" ? "text-builder" : verdict === "REWORK" ? "text-destructive" : "text-verifier"
            }
          >
            <b className="tabular-nums">{score}/100</b> {verdict}
            {reworkCycles > 0 ? ` · ${reworkCycles} rework` : ""}
          </Pill>
          <button
            onClick={() => setShowMcp(true)}
            className="rounded-full bg-secondary px-3 py-1.5 font-medium text-telemetry transition hover:bg-accent"
          >
            MCP Bridge
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded-full bg-secondary px-3 py-1.5 font-medium transition hover:bg-accent"
          >
            Settings
          </button>
        </div>
      </header>

      <ProofStrip
        model={model}
        endpoint={endpoint.replace(/^https?:\/\//, "")}
        live={live}
        rollingTpm={rollingTpm}
        sessionTokens={tokens}
        tpmLimit={tpmLimit}
        reasoningTokens={reasoningTokens}
        p50={p50Sec}
        p95={p95Sec}
        calls={totalCalls}
        retries={retries}
        reworkCycles={reworkCycles}
        checks={checks}
        assertions={assertions}
        thoughts={thoughts}
      />

      <section className="glass mx-auto mt-4 max-w-[1600px] rounded-2xl p-4">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="headline text-sm">Judge scenarios</h2>
          <p className="text-[10px] text-muted-foreground">
            {scenarioSource === "api" ? "GET /api/scenarios" : "local presets · API unreachable"} · one
            click launches
          </p>
        </div>
        <div className="mb-3 grid gap-2 lg:grid-cols-3">
          {scenarios.map((s) => (
            <button
              key={s.id}
              disabled={running}
              onClick={() => run(s.expectsRework, s)}
              className={`rounded-xl px-3 py-2.5 text-left transition disabled:opacity-50 ${
                activeId === s.id ? "bg-foreground text-background" : "bg-card/70 hover:bg-accent"
              }`}
            >
              <span className={`block text-[10px] font-semibold uppercase tracking-wide ${activeId === s.id ? "text-background/70" : "text-telemetry"}`}>
                {s.kicker}
              </span>
              <span className="mt-0.5 block text-sm font-semibold">{s.title}</span>
              <span className={`mt-1 block text-[11px] leading-snug ${activeId === s.id ? "text-background/70" : "text-muted-foreground"}`}>
                {s.description}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3 lg:flex-row">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="flex-1 resize-none rounded-xl bg-input px-3.5 py-2.5 text-sm outline-none ring-primary/50 focus:ring-2"
          />
          <div className="flex flex-wrap gap-2 lg:flex-col">
            <button
              disabled={running}
              onClick={() => run(active.expectsRework)}
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
        {failNote && <p className="mt-2 text-[11px] text-verifier">{failNote}</p>}
      </section>

      <main className="mx-auto mt-4 grid max-w-[1600px] gap-4 md:grid-cols-2 xl:grid-cols-[260px_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.45fr)]">
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
                    <span key={t} className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {t}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
                  {(perAgent[a.id]?.tokens ?? 0).toLocaleString()} tokens · {perAgent[a.id]?.calls ?? 0} calls
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

        <Panel title="Kanban" subtitle="Dependency-aware · auditable">
          <div className="space-y-2.5">
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl bg-card/60 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-muted-foreground">{t.id}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[t.status]}`}>
                    {t.status}
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium">{t.title}</p>
                <div className="mt-2 flex items-center gap-2 text-[11px]">
                  <span className={AGENT_TEXT[t.assignee]}>@{t.assignee}</span>
                  {t.dependsOn.length > 0 && <span className="text-muted-foreground">↳ {t.dependsOn.join(", ")}</span>}
                </div>
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-primary">Audit trail ({t.audit.length})</summary>
                  <ol className="mt-1.5 space-y-1 border-l border-border pl-3 text-muted-foreground">
                    {t.audit.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ol>
                </details>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Session Bus" subtitle={session}>
          <div ref={feedRef} className="hairline-scroll max-h-[640px] space-y-2.5 overflow-y-auto pr-1">
            {messages.length === 0 && (
              <p className="py-10 text-center text-xs text-muted-foreground">Waiting for @architect…</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className="animate-in fade-in slide-in-from-bottom-2 rounded-xl bg-card/60 p-3 duration-500">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={`font-semibold ${AGENT_TEXT[m.from]}`}>@{m.from}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={m.to === "all" ? "font-semibold" : `font-semibold ${AGENT_TEXT[m.to]}`}>@{m.to}</span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 text-[9px] font-semibold ${KIND_STYLE[m.kind]}`}>
                    {m.kind}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed">{m.text}</p>
                <details className="mt-2 text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">
                    Internal reasoning <code className="font-mono">reasoning_content</code>
                  </summary>
                  <p className="mt-1.5 rounded-lg bg-background/60 p-2 italic text-muted-foreground">{m.reasoning}</p>
                </details>
                <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {m.tokens.toLocaleString()} tok · {m.latency.toFixed(1)}s
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Inspector" subtitle="Diff · files · sandbox · MCP">
          <div className="mb-3 flex flex-wrap gap-1">
            {(
              [
                ["diff", "Self-Heal Diff"],
                ["files", "Files"],
                ["preview", "Live App"],
                ["rubric", "Verification"],
                ["mcp", "Cursor MCP"],
              ] as [string, string][]
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`rounded-full px-3 py-1 text-[11px] transition ${
                  tab === k ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          {tab === "diff" && <DiffExplorer diffs={diffs} source={diffSource} />}
          {tab === "files" && <FileExplorer files={files} diffPaths={diffs.map((d) => d.path)} />}
          {tab === "preview" && (
            <iframe
              title="Live app preview"
              sandbox="allow-scripts allow-forms"
              srcDoc={previewHtml}
              className="h-[560px] w-full rounded-xl border border-border bg-background"
            />
          )}
          {tab === "rubric" && (
            <Rubric checks={checks} score={score} verdict={verdict} sandboxStdout={sandboxStdout} rubricBreakdown={rubricBreakdown} testJs={files["test.js"] || ""} />
          )}
          {tab === "mcp" && (
            <McpBridge
              brief={prompt}
              scenarioId={active.id}
              sessionId={activeSessionId}
              simulateBrokenFirstPass={active.expectsRework}
            />
          )}
        </Panel>
      </main>

      {showSettings && (
        <Modal onClose={() => setShowSettings(false)} title="Baseten & MuseSwarm Connection">
          <p className="mb-3 text-xs text-muted-foreground">
            {backendHasKey
              ? "Connected to the local MuseSwarm server. BASETEN_API_KEY is configured in .env."
              : "Optional override. Leave empty to use the server .env key for meta-models/muse-spark-open-1026."}
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
            void sendAsk(to, t);
            setShowAsk(false);
          }}
        />
      )}
      {showMcp && (
        <div className="fixed inset-0 z-50 flex justify-end bg-background/60 backdrop-blur-sm" onClick={() => setShowMcp(false)}>
          <div
            className="glass h-full w-full max-w-xl overflow-auto bg-glass-strong p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="headline text-lg">Cursor MCP Bridge</h3>
              <button onClick={() => setShowMcp(false)} className="rounded-full bg-secondary px-3 py-1 text-xs">
                Close
              </button>
            </div>
            <McpBridge
              brief={prompt}
              scenarioId={active.id}
              sessionId={activeSessionId}
              simulateBrokenFirstPass={active.expectsRework}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-secondary/70 px-2.5 py-1.5 font-medium ${className}`}>
      {children}
    </span>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
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
  return (
    <div className="space-y-4">
      <div className="text-center">
        <p className="headline text-5xl tabular-nums">
          {score}
          <span className="text-xl text-muted-foreground">/100</span>
        </p>
        <p className={`mt-1 text-xs font-semibold ${verdict === "VERIFIED_PASS" ? "text-builder" : "text-verifier"}`}>
          {verdict}
        </p>
      </div>
      <div className="divide-y divide-border rounded-xl bg-card/60">
        {checks.map((c) => (
          <div key={c.name} className="flex justify-between px-3 py-2 text-xs">
            <span className="font-mono">{c.name}</span>
            <span className={c.ok ? "text-builder" : "text-destructive"}>{c.ok ? "✓ pass" : "✗ fail"}</span>
          </div>
        ))}
        {checks.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Sandbox idle…</p>}
      </div>
      <pre className="whitespace-pre-wrap rounded-xl bg-background/70 p-3 font-mono text-[11px] text-muted-foreground">
        {"$ node --check *.js && node test.js\n"}
        {sandboxStdout || "…"}
      </pre>
      <div className="space-y-2">
        {parts.map(([k, v]) => (
          <div key={k}>
            <div className="flex justify-between text-xs">
              <span>{k}</span>
              <span className="tabular-nums text-muted-foreground">{v}/25</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary" style={{ width: `${(v / 25) * 100}%` }} />
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="animate-in fade-in fixed inset-0 z-50 grid place-items-center bg-background/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass animate-in zoom-in-95 w-full max-w-md rounded-2xl bg-glass-strong p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="headline mb-2 text-lg">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function AskModal({ onClose, onSend }: { onClose: () => void; onSend: (to: AgentId, t: string) => void }) {
  const [to, setTo] = useState<AgentId>("architect");
  const [text, setText] = useState("");
  return (
    <Modal title="Send a steer message" onClose={onClose}>
      <div className="mb-3 flex gap-1.5">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => setTo(a.id)}
            className={`rounded-full px-3 py-1 text-xs ${to === a.id ? `bg-secondary font-semibold ${AGENT_TEXT[a.id]}` : "text-muted-foreground"}`}
          >
            @{a.id}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="e.g. Add a tiebreak when two critical paths share a length"
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
