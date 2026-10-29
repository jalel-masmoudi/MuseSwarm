# MuseSwarm — Multi-Agent Bot-to-Bot Software Engineering Platform

**Meta Global AI Developer Hackathon** • **Track:** Indie Developer Track • **Theme 2:** Push the Frontier

**MuseSwarm** orchestrates four specialized AI coding agents (`@architect`, `@builder`, `@verifier`, and `@lead`) powered by Meta's open-weight **Muse Spark Open** (`meta-models/muse-spark-open-1026`, 816B total / 42B active MoE, 1M context) running on **Baseten** (up to **2,000,000 TPM**), tightly integrated with **Cursor IDE (via MCP + Rules)** and **Meta Muse Code CLI** conventions (`AGENTS.md`, `.agents/memory`, `.muse/hooks.json`).

---

## Why MuseSwarm?

While Meta's `Muse Code` CLI introduces session messaging and multi-agent workflows, native session messaging is currently unavailable on Windows and requires manual multi-terminal coordination. **MuseSwarm** unlocks:
1. **Cross-Platform Bot-to-Bot Session Message Bus (`steer`, `queue`, `notify`):** Specialized agents negotiate specifications, hand off tasks, and challenge each other's code with full visibility into `Muse Spark Open`'s internal `reasoning_content`.
2. **Auditable Kanban Board (`brief.md` + `runbook.md`):** Inspired by Meta's Multi-Agent Orchestration cookbook, `@architect` acts as the Kanban arbiter (writes specs and task dependencies, never touches implementation code), while `@builder` implements and `@verifier` executes real sandbox tests.
3. **Autonomous Verification & Self-Healing Rework Loop:** `@verifier` runs `node --check` and `node test.js` inside an isolated workspace sandbox. If any test fails, `@verifier` automatically routes a rework task back to `@builder` with the stack trace until all checks pass.
4. **First-Class Cursor IDE + Web Studio + CLI Experience:**
   - **Cursor MCP Server (`.cursor/mcp.json`):** Invoke `muse_swarm_cobuild`, `muse_swarm_ask_agent`, or `muse_swarm_list_agents` directly from Cursor Chat/Composer.
   - **Real-Time Web Dashboard (`http://localhost:4321`):** Watch live bot-to-bot messages, `reasoning_content` traces, Kanban transitions, and Baseten 2,000,000 TPM telemetry for `meta-models/muse-spark-open-1026`. Judges can one-click three scenarios (self-healing bugfix, token-bucket + circuit breaker, DAG sprint engine), inspect every workspace file, and read the Pass 1 → Pass 2 diff. The Cursor MCP drawer invokes `muse_swarm_list_agents`, `muse_swarm_ask_agent`, `muse_swarm_cobuild`, and `muse_swarm_telemetry` (`POST /api/mcp/invoke` with `{ tool, arguments }`).
   - **Terminal CLI (`node src/cli.js`):** Run `doctor`, `peers`, or `run --demo` right from Cursor's integrated terminal.

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
Open this folder in **Cursor**. Cursor automatically detects `.cursor/mcp.json` (`muse-swarm` MCP server) and `.cursor/rules/muse-swarm.mdc`.
