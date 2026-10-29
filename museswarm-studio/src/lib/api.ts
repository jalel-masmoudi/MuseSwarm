import { LOCAL_SCENARIOS, type Scenario } from "./scenarios";
import { collectFiles, parseReworkDiffs, type ReworkFileDiff } from "./workspace";

export const MCP_CONFIG = `{
  "mcpServers": {
    "muse-swarm": {
      "command": "node",
      "args": ["src/mcp-server.js"],
      "env": { "BASETEN_API_KEY": "\${env:BASETEN_API_KEY}" }
    }
  }
}
`;

export type McpTool = {
  name: "muse_swarm_status" | "muse_swarm_run" | "muse_swarm_steer" | "muse_swarm_rework";
  description: string;
  inputSchema: Record<string, unknown>;
};

export const MCP_TOOLS: McpTool[] = [
  {
    name: "muse_swarm_status",
    description:
      "Live swarm status: @architect, @builder, @verifier, @lead, Baseten telemetry, and the active session.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "muse_swarm_run",
    description:
      "Start a multi-agent co-build. Body is { brief, scenarioId } on POST /api/swarm/run (prompt is mirrored for older servers).",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "Engineering brief for the swarm" },
        scenarioId: { type: "string", description: "Judge scenario id" },
        projectName: { type: "string" },
      },
      required: ["brief"],
    },
  },
  {
    name: "muse_swarm_steer",
    description: "Steer one specialist on the session bus (@architect, @builder, @verifier, @lead).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["architect", "builder", "verifier", "lead"] },
        message: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "muse_swarm_rework",
    description: "Open the @verifier → @builder self-healing loop (Pass 1 failure, Pass 2 patch).",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string" },
        scenarioId: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["brief"],
    },
  },
];

type JsonResult = { status: number; json: unknown; missing: boolean };

async function fetchJson(url: string, init?: RequestInit): Promise<JsonResult> {
  const res = await fetch(url, init);
  const ct = res.headers.get("content-type") || "";
  const missing = res.status === 404 || res.status === 501 || !ct.includes("json");
  if (missing) return { status: res.status, json: null, missing: true };
  return { status: res.status, json: await res.json(), missing: false };
}

function rec(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function normalizeScenario(raw: unknown): Scenario | null {
  const row = rec(raw);
  if (!row) return null;
  const id = str(row["id"] || row["slug"] || row["key"]);
  if (!id) return null;
  const local = LOCAL_SCENARIOS.find((s) => s.id === id);
  const remoteFiles = collectFiles(row["files"], row["artifacts"], row["workspace"]);
  const pass1 = collectFiles(row["pass1"], row["pass1Files"], row["filesPass1"]);
  const brief = str(row["brief"] || row["prompt"] || row["spec"], local?.brief ?? "");
  const title = str(row["title"] || row["name"], local?.title ?? id);
  const description = str(row["description"] || row["summary"], local?.description ?? "");
  const expects =
    typeof row["expectsRework"] === "boolean"
      ? row["expectsRework"]
      : (local?.expectsRework ?? /rework|heal|bug|race/i.test(`${id} ${title}`));
  const files = Object.keys(remoteFiles).length ? remoteFiles : (local?.files ?? {});
  const base: Scenario = local
    ? { ...local, id, title, description, brief, expectsRework: expects, files }
    : {
        id,
        title,
        kicker: "Judge",
        description,
        brief,
        expectsRework: expects,
        files,
        messages: [],
        tasks: [],
        passChecks: [],
        passStdout: "",
        score: typeof row["score"] === "number" ? row["score"] : 0,
      };
  if (Object.keys(pass1).length) base.pass1 = pass1;
  else if (Object.keys(remoteFiles).length) delete base.pass1;
  return base;
}

export async function loadScenarios(): Promise<{ scenarios: Scenario[]; source: "api" | "local" }> {
  try {
    const res = await fetchJson("/api/scenarios");
    if (res.missing || !res.json) return { scenarios: LOCAL_SCENARIOS, source: "local" };
    const body = rec(res.json);
    const list = Array.isArray(res.json)
      ? res.json
      : body?.["scenarios"] ?? body?.["presets"] ?? body?.["items"];
    if (!Array.isArray(list) || list.length === 0) return { scenarios: LOCAL_SCENARIOS, source: "local" };
    const mapped = list.map(normalizeScenario).filter((s): s is Scenario => Boolean(s));
    if (!mapped.length) return { scenarios: LOCAL_SCENARIOS, source: "local" };
    return { scenarios: mapped, source: "api" };
  } catch {
    return { scenarios: LOCAL_SCENARIOS, source: "local" };
  }
}

export async function pullSessionDiffs(sessionId: string): Promise<ReworkFileDiff[] | null> {
  try {
    const res = await fetchJson(`/api/session/${encodeURIComponent(sessionId)}/diffs`);
    if (res.missing || !res.json) return null;
    const body = rec(res.json);
    const parsed = parseReworkDiffs(body?.["reworkDiffs"] ?? body?.["diffs"] ?? res.json);
    return parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

export function deriveVerifyReport(session: Record<string, unknown>): string {
  const runs = Array.isArray(session["verificationRuns"]) ? session["verificationRuns"] : [];
  const rubric = rec(session["rubricEvaluation"]);
  const last = rec(runs[runs.length - 1]);
  return JSON.stringify(
    {
      source: "studio-derived-from-verificationRuns",
      verdict: rubric?.["verdict"] ?? (last?.["passed"] ? "VERIFIED_PASS" : "REWORK"),
      qualityScore: rubric?.["qualityScore"] ?? null,
      reworkCycles: session["reworkCycles"] ?? 0,
      sandbox: ["node --check", "node test.js"],
      runs: runs.map((run, i) => {
        const row = rec(run) ?? {};
        return {
          pass: i + 1,
          passed: Boolean(row["passed"]),
          checks: row["checks"] ?? [],
          stdout: row["stdout"] ?? "",
          stderr: row["stderr"] ?? "",
        };
      }),
    },
    null,
    2,
  );
}

async function fallbackInvoke(
  tool: string,
  args: Record<string, unknown>,
  sessionId: string | null,
): Promise<{ via: string; body: unknown }> {
  const brief = str(args["brief"] || args["prompt"]);
  const scenarioId = str(args["scenarioId"]);
  if (tool === "muse_swarm_status") {
    const res = await fetchJson("/api/status");
    return { via: "fallback GET /api/status", body: res.json ?? { ok: false, error: "status unavailable" } };
  }
  if (tool === "muse_swarm_run" || tool === "muse_swarm_rework") {
    const path = tool === "muse_swarm_rework" ? "/api/swarm/rework" : "/api/swarm/run";
    const res = await fetchJson(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brief,
        prompt: brief,
        scenarioId,
        projectName: args["projectName"] || scenarioId,
        sessionId: args["sessionId"] || sessionId,
        simulateBrokenFirstPass: tool === "muse_swarm_rework",
      }),
    });
    return { via: `fallback POST ${path}`, body: res.json ?? { ok: false, error: `${path} unavailable` } };
  }
  const res = await fetchJson("/api/swarm/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: args["agent"] || "architect",
      message: args["message"] || args["text"] || "",
      sessionId: args["sessionId"] || sessionId,
    }),
  });
  return {
    via: "fallback POST /api/swarm/message",
    body: res.json ?? { ok: false, error: "message unavailable" },
  };
}

export async function invokeMcpTool(
  tool: string,
  args: Record<string, unknown>,
  sessionId: string | null,
): Promise<{ latencyMs: number; via: string; body: unknown }> {
  const started = performance.now();
  try {
    const direct = await fetchJson("/api/mcp/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, arguments: args }),
    });
    if (!direct.missing) {
      return {
        latencyMs: Math.round(performance.now() - started),
        via: "POST /api/mcp/invoke",
        body: direct.json,
      };
    }
  } catch {
    // fall through to the stable HTTP routes
  }
  const fb = await fallbackInvoke(tool, args, sessionId);
  return { latencyMs: Math.round(performance.now() - started), via: fb.via, body: fb.body };
}
