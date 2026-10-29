# MuseSwarm — Multi-Agent Bot-to-Bot Software Engineering Platform

**Meta Global AI Developer Hackathon** • **Track:** Indie Developer Track • **Theme 2:** Push the Frontier

**MuseSwarm** orchestrates four specialized AI coding agents (`@architect`, `@builder`, `@verifier`, and `@lead`) powered by Meta's open-weight **Muse Spark Open** (`meta-models/muse-spark-open-1026`) running on **Baseten** (up to **2,000,000 TPM**), tightly integrated with **Cursor IDE (via MCP + Rules)** and MuseSwarm's own conventions (`AGENTS.md`, `.agents/memory`, `.muse/hooks.json`).

---

## Why MuseSwarm?

**MuseSwarm** unlocks:
1. **Cross-Platform Bot-to-Bot Session Message Bus (`steer`, `queue`, `notify`):** Specialized agents negotiate specifications, hand off tasks, and challenge each other's code with full visibility into `Muse Spark Open`'s internal `reasoning_content`.
2. **Auditable Kanban Board (`brief.md` + `runbook.md`):** MuseSwarm's own conventions: `@architect` acts as the Kanban arbiter (writes specs and task dependencies, never touches implementation code), while `@builder` implements and `@verifier` executes real sandbox tests.
3. **Autonomous Verification & Self-Healing Rework Loop:** `@verifier` runs `node --check` and `node test.js` inside an isolated workspace sandbox. If any test fails, `@verifier` automatically routes a rework task back to `@builder` with the stack trace until all checks pass.
4. **First-Class Cursor IDE + Web Studio + CLI Experience:**
   - **Cursor MCP Server (`.cursor/mcp.json`):** Invoke `muse_swarm_cobuild`, `muse_swarm_ask_agent`, or `muse_swarm_list_agents` directly from Cursor Chat/Composer.
   - **Real-Time Web Dashboard (`http://localhost:4321`):** Watch live bot-to-bot messages, `reasoning_content` traces, Kanban transitions, and Baseten 2,000,000 TPM telemetry for `meta-models/muse-spark-open-1026`. Judges can one-click three scenarios (self-healing bugfix, token-bucket + circuit breaker, DAG sprint engine), inspect every workspace file, and read the Pass 1 → Pass 2 diff. The Cursor MCP drawer invokes `muse_swarm_list_agents`, `muse_swarm_ask_agent`, `muse_swarm_cobuild`, and `muse_swarm_telemetry` (`POST /api/mcp/invoke` with `{ tool, arguments }`).
   - **Terminal CLI (`node src/cli.js`):** Run `doctor`, `peers`, `run --demo`, or `run --scenario <id>` right from Cursor's integrated terminal.

---

## Quick Start

### 1. Configure `.env`
Copy `.env.example` to `.env` and set your Baseten API key:
```env
BASETEN_API_KEY=your_baseten_api_key_here
BASETEN_BASE_URL=https://inference.baseten.co/v1
MUSE_MODEL_ID=meta-models/muse-spark-open-1026
PORT=4321
```

### 2. Verify Live Baseten `Muse Spark Open` Connection
```bash
node src/cli.js doctor
```

### 3. Run a Multi-Agent Co-Build Session in the Terminal
```bash
# Run the built-in multi-agent demo
npm run demo

# Or pass your own software prompt
node src/cli.js run "Build a Pomodoro Focus & Velocity Tracker with analytics, dark-mode UI, and unit tests"
```

### 4. Launch the Real-Time Web Studio Dashboard
```bash
npm start
```
Then open **http://localhost:4321** in your browser to watch the bots collaborate in real time and preview the generated web app.

### 5. Use Inside Cursor IDE
Open this folder in **Cursor**. Cursor automatically detects `.cursor/mcp.json` (`muse-swarm` MCP server) and `.cursor/rules/muse-swarm.mdc`. The same four tools are also callable from the Web Studio over `POST /api/mcp/invoke` with `{ "tool": "muse_swarm_list_agents", "arguments": {} }` (or `{ "name", "args" }`). The response is the MCP JSON-RPC result plus `latencyMs`.

### 6. Judge scenarios and the Pass 1 → Pass 2 diff
Three production scenarios ship as presets in `src/scenarios.js` and are exported as `SCENARIO_PRESETS`:

| id | What it builds |
| --- | --- |
| `sprint-priority-engine` | Weighted impact/urgency/effort queue and a minute-based SLA breach detector |
| `feature-flag-rollout` | FNV-1a percentage bucketing and a canary error-rate circuit breaker |
| `oncall-fairness-scheduler` | Timezone-aware handoffs, a Jain fairness index, and incident-fatigue rebalance |

```bash
node src/cli.js run --scenario feature-flag-rollout
node src/cli.js run --scenario oncall-fairness-scheduler
```

`POST /api/swarm/run` and `POST /api/swarm/rework` accept `scenarioId`. Each preset writes `brief.md`, `runbook.md`, `domain.js`, `app.js`, `test.js`, a dark-mode `index.html`, `README.md`, and `benchmark.json`. `GET /api/scenarios` returns the presets (also embedded on `GET /api/status`).

A rework run (`simulateBrokenFirstPass`, or `POST /api/swarm/rework`) injects one realistic Pass 1 fault, fails `node test.js`, then `@builder` restores the healed source. Every `writeWorkspaceFile` appends a `fileHistory` snapshot. The heal records a unified diff on `reworkDiffs` (`-` broken line, `+` healed line, plus before/after snippets). Read them from the session payload or `GET /api/session/:id/diffs` (`GET /api/swarm/diffs` accepts `?sessionId=`). The same arrays are stored in `benchmark.json`.

---

## Hosted demo

**Live Studio:** [https://museswarm.onrender.com](https://museswarm.onrender.com)  
**Demo video** (unlisted YouTube, 1:23): [https://youtu.be/Iom-c3aXK4s](https://youtu.be/Iom-c3aXK4s)  
**Source code:** [https://github.com/jalel-masmoudi/MuseSwarm](https://github.com/jalel-masmoudi/MuseSwarm)

Render free plan (Frankfurt, Docker, `MUSE_SWARM_PUBLIC_DEMO=1`, auto-deploys from `main`). It replays the three golden live sessions and **never calls Baseten**. After idle the free-tier instance may cold-start in about **30–60 seconds**. `GET /api/health` reports `mode: public-demo`.

To run the same mode locally:

```bash
MUSE_SWARM_PUBLIC_DEMO=1 npm start
```

`MUSE_SWARM_PUBLIC_DEMO=1` loads the three committed golden live sessions (`workspaces/golden-*`), serves them through the existing session / diffs / SSE / preview APIs, and **disables live Baseten even if `BASETEN_API_KEY` is present**. POST `/api/swarm/run` and `/api/swarm/rework` still run, but only as offline deterministic heals (`offline_fixture` / `deterministic_restore`) — they are rate-limited and capped on concurrent sandbox processes. Ephemeral (non-golden) workspaces are bounded: at most `MUSE_SWARM_DEMO_MAX_WORKSPACES` (default 20) and a TTL of `MUSE_SWARM_DEMO_WORKSPACE_TTL_MS` (default 30 minutes). The oldest completed dirs are pruned on each new run and on a periodic sweep; golden-* dirs, `workspaces/golden/`, the committed `sprint-priority-engine-8z24` reference, anything outside `workspaces/`, and mid-run sessions are never deleted. `GET /api/status` reports `prunedWorkspaces`. `GET /api/status` and `GET /api/health` report `mode: public-demo`. `GET /api/events?sessionId=<golden-id>` replays the recorded agent/file/verification events with paced SSE.

| workspace | session | healedBy |
| --- | --- | --- |
| `golden-sprint-priority-engine-bvy7` | `swarm-mvti4gn7-bvy7` | `model` |
| `golden-feature-flag-rollout-fxhd` | `swarm-mvti5hti-fxhd` | `model` |
| `golden-oncall-fairness-scheduler-feo0` | `swarm-mvti6mtl-feo0` | `deterministic_restore` |

That is the honest **2-of-3** live-heal claim (sprint + flags by Muse Spark; oncall restored by the engine after the model reintroduced a sort-direction bug).

### Deploy

- `Dockerfile` — Node 22 LTS (`node:22-alpine`), non-root `museswarm` user, `PORT` (default 4321), `MUSE_SWARM_PUBLIC_DEMO=1`, healthcheck `GET /api/health`.
- `render.yaml` — free-tier Docker web service, `healthCheckPath: /api/health`.
- `fly.toml` — free-tier shared 256 MB VM, auto-stop, HTTP check on `/api/health`.

**Static UI choice:** `.dockerignore` excludes `museswarm-studio/dist`, `node_modules`, `.env*`, and generated workspaces (goldens are kept). `server.js` serves `museswarm-studio/dist` *before* `public/` when dist exists; without dist the image serves `public/`, which the Studio bundle PR rebuilds. We chose this over a Docker multi-stage Studio build so this PR never ships a stale Vite bundle and never edits `museswarm-studio/**` or `public/**`.

**Why not Vercel / serverless:** the dashboard is a long-lived Node process. It holds SSE connections, writes `workspaces/`, and spawns `node --check` / `node test.js` child processes with timeouts. Serverless request limits and a read-only filesystem are a poor fit, so this repo ships Docker + Render/Fly instead of a `vercel.json`.

## License
MIT, see LICENSE.
