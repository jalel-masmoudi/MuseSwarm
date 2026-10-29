# Meta Global AI Developer Hackathon — Submission Package (Ready to Submit)

- **Submission Portal URL:** `https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit`
- **Event ID:** `78e32764-9651-4942-b1eb-4401af6a3209`
- **Submission Window Status:** **OPEN** (`on-time` phase; closes **Wednesday, Nov 4, 2026 at 9:00 PM EST** / **Thursday, Nov 5, 2026 at 3:00 AM Africa/Tunis**, with a 6-hour grace period).

---

## Drafted Form Fields

- **Team / Project Name:** `MuseSwarm`
- **Track:** `Indie Dev Track` (Individual builders & students)
- **Project Theme:** `Theme 2: Push the Frontier` (Software challenge — Multi-Agent Bot-to-Bot Software Engineering Collaboration)
- **Team Members:** `Med Jalel Masmoudi` (`m.j.masmoudi1@gmail.com` / GitHub: `jalel-masmoudi`)
- **Models & Meta AI Tooling Used:**
  - **Meta Muse Spark Open** (`meta-models/muse-spark-open-1026` — 816B total / 42B active MoE, 1M context window) hosted on **Baseten** (`https://inference.baseten.co/v1`, 2,000,000 TPM capacity)
  - **Meta Muse Code CLI Architecture** (`AGENTS.md`, `.agents/memory/MEMORY.md`, `.muse/hooks.json`, session messaging `steer`/`queue`/`notify`, and auditable Kanban orchestration)
  - **Cursor IDE MCP Integration** (`.cursor/mcp.json` + `.cursor/rules/muse-swarm.mdc` exposing 4 native MCP tools)

### Short Description / Tagline
> **MuseSwarm** is a multi-agent bot-to-bot software engineering platform powered by Meta's open-weight `Muse Spark Open` (`meta-models/muse-spark-open-1026`) on Baseten (2M TPM) and integrated into Cursor IDE via MCP. Four specialized peer bots (`@architect`, `@builder`, `@verifier`, and `@lead`) negotiate specs over a live session message bus, track dependencies on an auditable Kanban board, execute sandbox runtime tests (`node test.js`), and autonomously self-heal defects in a rework loop until verification passes.

### Full Technical Description (Impact, Use of Meta AI Tooling, Technical Depth & Execution)
1. **Problem & Impact (30%):**
   Single-agent coding assistants often drift in scope or ship untested code because the same context writes both the specification and the implementation. Meanwhile, Meta's new `Muse Code` CLI introduces multi-agent session messaging, but native session messaging is unavailable on Windows and requires manual multi-terminal setup. **MuseSwarm** bridges this gap across Windows, macOS, and Linux by orchestrating four specialized `Muse Spark Open` agents with strict role separation and automated sandbox verification.
2. **Use of Meta AI Tooling (25%):**
   - Powered by **`meta-models/muse-spark-open-1026`** on **Baseten** (`https://inference.baseten.co/v1`, up to 2M TPM), extracting and surfacing `Muse Spark Open`'s internal chain-of-thought (`reasoning_content`) alongside structured peer messages.
   - Implements Meta's **Multi-Agent Orchestration Contract** (`profiles/*/SOUL.md`, `brief.md`, `runbook.md`, and `AGENTS.md`): `@architect` owns the spec and Kanban board without touching code; `@builder` implements isomorphic modules (`app.js`), interactive UI (`index.html`), and unit tests (`test.js`); `@verifier` runs real sandbox checks (`node --check` + `node test.js`) and triggers multi-turn rework loops with stack traces; `@lead` synthesizes documentation and `benchmark.json`.
3. **Technical Depth & Execution (20%):**
   - **Resilient Baseten Inference Client (`src/baseten-client.js`):** 45s `AbortController` timeouts, exponential backoff + jitter + `Retry-After` handling on HTTP 408/429/5xx, rolling 60s TPM/RPM window tracking, p50/p95 latency percentiles, and per-agent token breakdown.
   - **Dependency-Aware Kanban & Parallel Fan-Out (`src/swarm-engine.js`):** Supports `steer`, `queue`, and `notify` delivery modes, DAG task dependencies (`dependsOn`), parallel task fan-out (`runParallelTasks`), a 100-point automated quality rubric, and autonomous `@verifier -> @builder` self-healing rework loops. Each workspace write snapshots `fileHistory`. A Pass 1 → Pass 2 heal stores a unified diff (`-` broken line, `+` healed line, before/after snippets) on `reworkDiffs`, the session payload, and `benchmark.json`, served at `GET /api/session/:id/diffs`.
   - **Three judge scenarios (`src/scenarios.js`):** `sprint-priority-engine` (weighted incident scoring + SLA detector), `feature-flag-rollout` (FNV-1a bucketing + canary circuit breaker), and `oncall-fairness-scheduler` (timezone handoffs + Jain fairness rebalance). Each emits `domain.js`, `app.js`, `test.js`, and a dark-mode `index.html` that pass `node --check` and `node test.js` after the self-heal. `GET /api/scenarios` lists them.
   - **Triple Interface:** Terminal CLI (`node src/cli.js doctor | peers | run --demo | run --scenario <id> | benchmark`), Real-Time SSE Web Studio (`http://localhost:4321` with judge scenario presets, a Pass 1 → Pass 2 self-healing diff, multi-file artifacts, live `reasoning_content`, Kanban, and an embedded live app preview), and a 4-tool **Cursor MCP Server** (`src/mcp-server.js`) the studio calls through `POST /api/mcp/invoke` (`muse_swarm_list_agents`, `muse_swarm_ask_agent`, `muse_swarm_cobuild`, `muse_swarm_telemetry`).
4. **Live Verification Results (25%):**
   - **Rubric Score:** `98/100 (VERIFIED_PASS)`
   - **Sandbox Checks:** `4/4` checks passed (`syntax:app.js`, `syntax:test.js`, `runtime:test.js` 5/5 suites / 8 assertions, `artifact:index.html`) in `675ms`.
   - **Baseten Telemetry:** 4 live `meta-models/muse-spark-open-1026` calls (`p50 = 9,217ms`, `p95 = 18,095ms`), `16,916` total tokens (`8,260` reasoning tokens), `0.85%` of the 2,000,000 TPM limit.
