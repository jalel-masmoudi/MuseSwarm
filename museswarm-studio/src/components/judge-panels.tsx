import { useEffect, useMemo, useState } from "react";
import { MCP_CONFIG, MCP_TOOLS, invokeMcpTool } from "@/lib/api";
import { diffLines, diffStats, pairDiffRows, unifiedDiff, type DiffOp } from "@/lib/diff";
import type { AgentId } from "@/lib/swarm-data";

const AGENT_TEXT: Record<AgentId, string> = {
  architect: "text-architect",
  builder: "text-builder",
  verifier: "text-verifier",
  lead: "text-lead",
};
import { diffChanged, hasLineDiff, type ReworkFileDiff } from "@/lib/workspace";

const PIN = [
  "brief.md",
  "runbook.md",
  "solution.js",
  "token-bucket.js",
  "circuit-breaker.js",
  "app.js",
  "test.js",
  "verify-report.json",
  "index.html",
  "README.md",
  "benchmark.json",
];

export function orderFiles(files: Record<string, string>): string[] {
  return Object.keys(files).sort((a, b) => {
    const ia = PIN.indexOf(a);
    const ib = PIN.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

export function ProofStrip({
  model,
  endpoint,
  live,
  rollingTpm,
  sessionTokens,
  tpmLimit,
  reasoningTokens,
  p50,
  p95,
  calls,
  retries,
  reworkCycles,
  checks,
  assertions,
  thoughts,
}: {
  model: string;
  endpoint: string;
  live: boolean;
  rollingTpm: number;
  sessionTokens: number;
  tpmLimit: number;
  reasoningTokens: number;
  p50: number;
  p95: number;
  calls: number;
  retries: number;
  reworkCycles: number;
  checks: { name: string; ok: boolean }[];
  assertions: number;
  thoughts: { id: AgentId; state: string; text: string }[];
}) {
  const syntax = checks.filter((c) => c.name.startsWith("syntax:"));
  const syntaxOk = syntax.filter((c) => c.ok).length;
  const runtime = checks.find((c) => c.name === "runtime:test.js");
  const pct = tpmLimit > 0 ? (Math.max(rollingTpm, sessionTokens) / tpmLimit) * 100 : 0;
  return (
    <section className="judge-proof glass mx-auto mt-3 max-w-[1600px] rounded-2xl px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-telemetry">
            Judge proof · Meta Global AI Developer Hackathon · Theme 2 · Push the Frontier
          </p>
          <p className="headline mt-1 font-mono text-[15px] text-foreground">{model}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            Baseten {endpoint} · {live ? "live key" : "demo simulation"} · reasoning_content on the bus
          </p>
        </div>
        <div className="text-right">
          <p className="headline tabular-nums text-2xl">
            {sessionTokens.toLocaleString()}
            <span className="ml-1 text-sm text-muted-foreground">/ {tpmLimit.toLocaleString()} TPM</span>
          </p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            rolling {rollingTpm.toLocaleString()} TPM · {pct.toFixed(2)}% of budget · reasoning{" "}
            {reasoningTokens.toLocaleString()} · p50 {p50.toFixed(1)}s · p95 {p95.toFixed(1)}s · {calls} calls ·{" "}
            {retries} retries · {reworkCycles} rework
          </p>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-telemetry transition-all duration-700"
          style={{ width: `${Math.max(1.5, Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
        sandbox{" "}
        <span className={syntax.length && syntaxOk === syntax.length ? "text-builder" : "text-verifier"}>
          node --check {syntax.length ? `${syntaxOk}/${syntax.length}` : "—"}
        </span>
        {" · "}
        <span className={runtime?.ok ? "text-builder" : runtime ? "text-destructive" : "text-muted-foreground"}>
          node test.js {runtime ? (runtime.ok ? `PASSED · ${assertions} assertions` : "FAILED") : "idle"}
        </span>
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {thoughts.map((t) => (
          <div key={t.id} className="rounded-xl bg-background/50 px-3 py-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className={`font-semibold ${AGENT_TEXT[t.id]}`}>@{t.id}</span>
              <span className="text-muted-foreground">{t.state}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[11px] italic leading-snug text-muted-foreground">
              <span className="mr-1 font-mono text-[10px] not-italic text-telemetry">reasoning_content</span>
              {t.text}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

type FocusItem =
  | { type: "row"; row: { left: DiffOp | null; right: DiffOp | null }; key: number }
  | { type: "skip"; count: number; key: string };

function focusRows(rows: { left: DiffOp | null; right: DiffOp | null }[], context = 2): FocusItem[] {
  const hot = rows.map((row) => {
    const left = row.left?.kind;
    const right = row.right?.kind;
    return (left !== undefined && left !== "eq") || (right !== undefined && right !== "eq");
  });
  const keep = rows.map((_, i) => hot.some((on, j) => on && Math.abs(i - j) <= context));
  const out: FocusItem[] = [];
  let skip = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (skip) out.push({ type: "skip", count: skip, key: `s-${i}` });
      skip = 0;
      out.push({ type: "row", row, key: i });
    } else {
      skip += 1;
    }
  });
  if (skip) out.push({ type: "skip", count: skip, key: "s-end" });
  return out;
}

function DiffLine({ op, side }: { op: DiffOp | null; side: "left" | "right" }) {
  if (!op) return <div className="min-h-[1.35rem]" />;
  const mark = op.kind === "del" ? "−" : op.kind === "add" ? "+" : " ";
  const tone =
    op.kind === "del"
      ? "diff-del text-destructive"
      : op.kind === "add"
        ? "diff-add text-builder"
        : "text-muted-foreground";
  return (
    <div className={`whitespace-pre px-2 font-mono text-[11px] leading-relaxed ${tone}`}>
      {mark}
      {op.line || " "}
    </div>
  );
}

export function DiffExplorer({ diffs, source }: { diffs: ReworkFileDiff[]; source: string }) {
  const changed = diffs.filter(diffChanged);
  const changedKey = changed.map((d) => d.path).join("|");
  const prefer = (list: ReworkFileDiff[]) =>
    list.find((d) => d.path === "solution.js")?.path ??
    list.find((d) => d.path === "app.js")?.path ??
    list[0]?.path ??
    "";
  const [path, setPath] = useState(() => prefer(changed));
  const [mode, setMode] = useState<"split" | "unified">("split");
  useEffect(() => {
    if (!changed.some((d) => d.path === path)) setPath(prefer(changed));
  }, [changedKey, path, changed]);
  const current = changed.find((d) => d.path === path) ?? changed[0];
  const before = current?.pass1 ?? "";
  const after = current?.pass2 ?? "";
  const ops = useMemo(() => (current && hasLineDiff(current) ? diffLines(before, after) : []), [current, before, after]);
  const rows = useMemo(() => focusRows(pairDiffRows(ops)), [ops]);
  const stats = diffStats(ops);
  const unified =
    current?.unified && current.unified.trim()
      ? current.unified
      : current && hasLineDiff(current)
        ? unifiedDiff(current.path, before, after)
        : "";

  if (!current) {
    return (
      <div className="rounded-xl bg-card/60 px-4 py-8 text-center text-sm text-muted-foreground">
        <p className="headline text-base text-foreground">Self-healing diff</p>
        <p className="mt-2">
          Pass 1 (REWORK) versus Pass 2 (VERIFIED_PASS) shows up here when <code>reworkDiffs</code> or{" "}
          <code>GET /api/session/:id/diffs</code> returns a patch. Launch the bugfix scenario to see the lost-update
          fix.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold text-destructive">
          Pass 1 · REWORK
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="rounded-full bg-builder/15 px-2 py-0.5 text-[10px] font-semibold text-builder">
          Pass 2 · VERIFIED_PASS
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {source}
          {ops.length ? ` · +${stats.added} −${stats.removed}` : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {changed.map((d) => (
          <button
            key={d.path}
            onClick={() => setPath(d.path)}
            className={`rounded-full px-3 py-1 font-mono text-[11px] ${
              d.path === current.path ? "bg-foreground text-background" : "bg-secondary text-muted-foreground"
            }`}
          >
            {d.path}
          </button>
        ))}
        <button
          onClick={() => setMode(mode === "split" ? "unified" : "split")}
          className="rounded-full bg-secondary px-3 py-1 text-[11px] text-primary"
        >
          {mode === "split" ? "Unified patch" : "Split view"}
        </button>
      </div>
      {mode === "split" && hasLineDiff(current) ? (
        <div className="grid overflow-hidden rounded-xl border border-border md:grid-cols-2">
          <div className="border-b border-border md:border-b-0 md:border-r">
            <div className="border-b border-border px-2 py-1 text-[10px] font-semibold text-destructive">
              Pass 1 · {current.path}
            </div>
            <div className="hairline-scroll max-h-[480px] overflow-auto py-1">
              {rows.map((item) =>
                item.type === "skip" ? (
                  <div key={item.key} className="px-2 py-1 text-center font-mono text-[10px] text-muted-foreground">
                    ··· {item.count} unchanged ···
                  </div>
                ) : (
                  <DiffLine
                    key={item.key}
                    op={item.row.left && item.row.left.kind === "add" ? null : item.row.left}
                    side="left"
                  />
                ),
              )}
            </div>
          </div>
          <div>
            <div className="border-b border-border px-2 py-1 text-[10px] font-semibold text-builder">
              Pass 2 · {current.path}
            </div>
            <div className="hairline-scroll max-h-[480px] overflow-auto py-1">
              {rows.map((item) =>
                item.type === "skip" ? (
                  <div key={item.key} className="px-2 py-1 text-center font-mono text-[10px] text-muted-foreground">
                    ··· {item.count} unchanged ···
                  </div>
                ) : (
                  <DiffLine
                    key={item.key}
                    op={item.row.right && item.row.right.kind === "del" ? null : item.row.right}
                    side="right"
                  />
                ),
              )}
            </div>
          </div>
        </div>
      ) : (
        <pre className="hairline-scroll max-h-[520px] overflow-auto rounded-xl bg-background/80 p-3 font-mono text-[11px] leading-relaxed">
          {unified.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("+") && !line.startsWith("+++")
                  ? "diff-add text-builder"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "diff-del text-destructive"
                    : "text-muted-foreground"
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

export function FileExplorer({
  files,
  diffPaths,
}: {
  files: Record<string, string>;
  diffPaths: string[];
}) {
  const names = orderFiles(files);
  const [active, setActive] = useState(names[0] ?? "brief.md");
  useEffect(() => {
    if (!names.includes(active)) setActive(names[0] ?? "");
  }, [names, active]);
  const body = files[active] ?? "";
  return (
    <div className="grid gap-2 md:grid-cols-[168px_minmax(0,1fr)]">
      <div className="hairline-scroll max-h-[520px] space-y-1 overflow-auto">
        {names.map((name) => (
          <button
            key={name}
            onClick={() => setActive(name)}
            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left font-mono text-[11px] ${
              name === active ? "bg-foreground text-background" : "bg-card/50 text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="truncate">{name}</span>
            {diffPaths.includes(name) && <span className="ml-1 text-[9px] text-verifier">diff</span>}
          </button>
        ))}
        {names.length === 0 && <p className="px-2 text-[11px] text-muted-foreground">No artifacts yet.</p>}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-background/70">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{active || "file"}</span>
          <button onClick={() => navigator.clipboard.writeText(body)} className="text-primary">
            Copy
          </button>
        </div>
        <pre className="hairline-scroll max-h-[480px] overflow-auto p-3 font-mono text-[11px] leading-relaxed">{body}</pre>
      </div>
    </div>
  );
}

export function McpBridge({
  brief,
  scenarioId,
  sessionId,
  simulateBrokenFirstPass,
}: {
  brief: string;
  scenarioId: string;
  sessionId: string | null;
  simulateBrokenFirstPass: boolean;
}) {
  const [tool, setTool] = useState(MCP_TOOLS[0]!.name);
  const [agent, setAgent] = useState<AgentId>("architect");
  const [message, setMessage] = useState("What should @verifier re-check after the lost-update patch?");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ latencyMs: number; via: string; body: unknown } | null>(null);
  const [error, setError] = useState("");
  const spec = MCP_TOOLS.find((t) => t.name === tool) ?? MCP_TOOLS[0]!;

  async function invoke() {
    setBusy(true);
    setError("");
    const args: Record<string, unknown> =
      tool === "muse_swarm_ask_agent"
        ? { agent, message }
        : tool === "muse_swarm_cobuild"
          ? {
              prompt: brief,
              projectName: scenarioId,
              scenarioId,
              simulateBrokenFirstPass,
            }
          : {};
    try {
      const out = await invokeMcpTool(tool, args, sessionId);
      setResult(out);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        JSON-RPC tools on the Cursor bridge. Invoke posts <code>{`{ tool, arguments }`}</code> to{" "}
        <code>POST /api/mcp/invoke</code>. A 404 (route not merged yet) falls back to the live HTTP API and still
        prints the JSON and latency.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {MCP_TOOLS.map((t) => (
          <button
            key={t.name}
            onClick={() => setTool(t.name)}
            className={`rounded-xl px-3 py-2 text-left ${
              tool === t.name ? "bg-foreground text-background" : "bg-card/60"
            }`}
          >
            <span className="block font-mono text-[11px]">{t.name}</span>
            <span className={`mt-1 block text-[10px] ${tool === t.name ? "text-background/70" : "text-muted-foreground"}`}>
              {t.description}
            </span>
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px]">
          <span className="font-mono text-muted-foreground">{spec.name} inputSchema</span>
          <button
            onClick={() => navigator.clipboard.writeText(JSON.stringify(spec.inputSchema, null, 2))}
            className="text-primary"
          >
            Copy schema
          </button>
        </div>
        <pre className="hairline-scroll max-h-40 overflow-auto p-3 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(spec.inputSchema, null, 2)}
        </pre>
      </div>
      {tool === "muse_swarm_ask_agent" && (
        <div className="space-y-2">
          <div className="flex gap-1">
            {(["architect", "builder", "verifier", "lead"] as AgentId[]).map((id) => (
              <button
                key={id}
                onClick={() => setAgent(id)}
                className={`rounded-full px-2 py-1 text-[11px] ${agent === id ? "bg-secondary text-foreground" : "text-muted-foreground"}`}
              >
                @{id}
              </button>
            ))}
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-xl bg-input px-3 py-2 text-sm outline-none ring-primary/40 focus:ring-2"
          />
        </div>
      )}
      {tool === "muse_swarm_cobuild" && (
        <p className="rounded-xl bg-card/50 px-3 py-2 font-mono text-[10px] text-muted-foreground">
          prompt = brief above · projectName={scenarioId || "—"} · scenarioId={scenarioId || "—"} ·
          simulateBrokenFirstPass={String(simulateBrokenFirstPass)}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          disabled={
            busy ||
            (tool === "muse_swarm_cobuild" && !brief.trim()) ||
            (tool === "muse_swarm_ask_agent" && !message.trim())
          }
          onClick={invoke}
          className="rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Invoking…" : "Invoke tool"}
        </button>
        {result && (
          <span className="font-mono text-[11px] text-telemetry">
            {result.latencyMs} ms · {result.via}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result && (
        <pre className="hairline-scroll max-h-72 overflow-auto rounded-xl bg-background/80 p-3 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(result.body, null, 2)}
        </pre>
      )}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="font-mono">.cursor/mcp.json</span>
          <button onClick={() => navigator.clipboard.writeText(MCP_CONFIG)} className="text-primary">
            Copy
          </button>
        </div>
        <pre className="overflow-auto p-3 font-mono text-[11px]">{MCP_CONFIG}</pre>
      </div>
    </div>
  );
}
