import { LOCAL_SCENARIOS, type Scenario } from "./scenarios";
import { collectFiles, parseReworkDiffs, type ReworkFileDiff } from "./workspace";

export const MCP_CONFIG = `{
  "mcpServers": {
    "muse-swarm": {
      "command": "node",
      "args": ["src/mcp-server.js"],
      "env": { "BASETEN_API_KEY": "\${env:BASETEN_API_KEY}" },
      "tools": [
        "muse_swarm_list_agents",
        "muse_swarm_ask_agent",
        "muse_swarm_cobuild",
        "muse_swarm_telemetry"
      ]
    }
  }
}
`;

export type McpToolName =
  | "muse_swarm_list_agents"
  | "muse_swarm_ask_agent"
  | "muse_swarm_cobuild"
  | "muse_swarm_telemetry";

export type McpTool = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Schemas copied from src/mcp-server.js. cobuild also lists the optional fields PR #1's POST /api/mcp/invoke forwards. */
export const MCP_TOOLS: McpTool[] = [
  {
    name: "muse_swarm_list_agents",
    description:
      "List the specialized MuseSwarm bots (@architect, @builder, @verifier, @lead), their toolsets, and Baseten Muse Spark Open telemetry.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "muse_swarm_ask_agent",
    description:
      "Send a direct peer message to a specific MuseSwarm specialist (@architect, @builder, @verifier, or @lead) powered by meta-models/muse-spark-open-1026 on Baseten.",
    inputSchema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: ["architect", "builder", "verifier", "lead"],
          description: "Target specialist agent ID",
        },
        message: {
          type: "string",
          description: "Question, code snippet, or task to send to the specialist bot",
        },
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "muse_swarm_cobuild",
    description:
      "Run a full autonomous multi-agent bot-to-bot software build session (@architect -> @builder -> @verifier -> @lead) with Kanban tracking, rubric scoring, and sandbox test verification.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Software feature or application specification for the swarm to co-build and verify",
        },
        projectName: {
          type: "string",
          description: "Optional short slug for the output workspace folder",
        },
        scenarioId: {
          type: "string",
          description: "Optional judge scenario preset id",
        },
        simulateBrokenFirstPass: {
          type: "boolean",
          description: "Inject a Pass 1 fault so @verifier and @builder run the self-heal loop",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "muse_swarm_telemetry",
    description:
      "Retrieve Baseten Muse Spark Open 2M TPM rolling window utilization, p50/p95 latency percentiles, reasoning token statistics, and active swarm session benchmarks.",
    inputSchema: {
      type: "object",
      properties: {},
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
  if (tool === "muse_swarm_list_agents") {
    const res = await fetchJson("/api/status");
    return { via: "fallback GET /api/status", body: res.json ?? { ok: false, error: "status unavailable" } };
  }
  if (tool === "muse_swarm_telemetry") {
    const res = await fetchJson("/api/telemetry");
    return { via: "fallback GET /api/telemetry", body: res.json ?? { ok: false, error: "telemetry unavailable" } };
  }
  if (tool === "muse_swarm_cobuild") {
    const prompt = str(args["prompt"] || args["brief"]);
    const scenarioId = str(args["scenarioId"]);
    const res = await fetchJson("/api/swarm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        brief: prompt,
        projectName: args["projectName"] || scenarioId,
        scenarioId,
        simulateBrokenFirstPass: Boolean(args["simulateBrokenFirstPass"]),
      }),
    });
    return { via: "fallback POST /api/swarm/run", body: res.json ?? { ok: false, error: "/api/swarm/run unavailable" } };
  }
  const res = await fetchJson("/api/swarm/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: args["agent"] || "architect",
      message: args["message"] || "",
      sessionId,
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
