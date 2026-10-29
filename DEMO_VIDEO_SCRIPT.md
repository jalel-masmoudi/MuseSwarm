# MuseSwarm — Official 81-Second Hackathon Demo Video Script

- **Project:** MuseSwarm — Multi-Agent Bot-to-Bot Software Engineering Platform
- **Hackathon:** Meta Global AI Developer Hackathon (`$1,000,000` Prize Pool)
- **Track & Theme:** Indie Developer Track • Theme 2: *Push the Frontier* (Software Challenge)
- **Model & Inference Stack:** Meta `Muse Spark Open` (`meta-models/muse-spark-open-1026`, 816B total / 42B active MoE, 1M context) on **Baseten** (`https://inference.baseten.co/v1`, up to `2,000,000 TPM`) + **Meta Muse Code CLI** (`AGENTS.md`, `SOUL.md`, `.agents/memory`, `.muse/hooks.json`) + **Cursor IDE MCP Server** (`src/mcp-server.js`).
- **Output Video Specs:** `1920x1080` (Full HD, 30 fps, H.264 `yuv420p` + AAC 44.1 kHz stereo audio), **81.27 seconds** total across 6 timed scenes.

---

## Scene-by-Scene Breakdown & Exact Voiceover Narration

### Scene 1 — Product Vision & Problem (0:00.0 – 0:13.4 | 13.43s)
- **Captured Frame:** `demo-frames/frame1_hero.png` — Full `1920x1080` hero view of **MuseSwarm Studio** at `http://localhost:4321` in `LIVE BASETEN` mode, showing the 4 peer bots (`@architect`, `@builder`, `@verifier`, `@lead`), active session `sprint-priority-engine-8z24`, `98/100 VERIFIED_PASS` badge, and the interactive Live App preview.
- **Lower-Third Overlay:** `SCENE 01 / 06  |  MUSESWARM STUDIO — Multi-Agent Bot-to-Bot Software Co-Builder (Meta Muse Code + Cursor IDE)`
- **Spoken Narration:**
  > "Single-agent coding tools often drift in scope or ship untested code. Meet MuseSwarm: a multi-agent bot-to-bot engineering platform for the Meta Global AI Hackathon, bringing Meta Muse Code architecture to Windows, macOS, Linux, and Cursor IDE."

---

### Scene 2 — Four Specialized Peer Bots & Session Message Bus (0:13.4 – 0:28.2 | 14.76s)
- **Captured Frame:** `demo-frames/frame2_session_bus.png` — Peer Agents roster with expanded `SOUL.md` definitions (`@architect`, `@builder`, `@verifier`, `@lead`) and the real-time **Session Bus** displaying `STEER`, `QUEUE`, and `NOTIFY` messages with expanded `reasoning_content` chain-of-thought blocks.
- **Lower-Third Overlay:** `SCENE 02 / 06  |  BOT-TO-BOT SESSION BUS — @architect, @builder, @verifier & @lead + reasoning_content CoT`
- **Spoken Narration:**
  > "Four peer bots coordinate over a session bus using steer, queue, and notify handoffs. Architect writes brief and runbook dot M D, Builder codes app and test dot J S, Verifier runs sandbox tests, and Lead writes benchmark dot J S O N, surfacing Muse Spark Open reasoning content."

---

### Scene 3 — Baseten `meta-models/muse-spark-open-1026` & 2M TPM Telemetry (0:28.2 – 0:40.6 | 12.38s)
- **Captured Frame:** `demo-frames/frame3_baseten_telemetry.png` — Live Baseten telemetry bar (`meta-models/muse-spark-open-1026 · LIVE BASETEN`, `16,916 / 2,000,000 TPM (0.85%)`, `p50 9.2s · p95 18.1s · Reasoning 8,260 · Calls 4 · Retries 0`) and `benchmark.json` artifact inspector (`reworkCycles`, `agentBreakdown`, `/api/health`, `/api/telemetry`, `/api/status`, `/api/events`).
- **Lower-Third Overlay:** `SCENE 03 / 06  |  BASETEN 2M TPM BACKEND — meta-models/muse-spark-open-1026 • 45s Timeout & Backoff • /api/telemetry`
- **Spoken Narration:**
  > "Every agent runs live on Meta Muse Spark Open ten-twenty-six on Baseten with a two-million TPM budget, forty-five-second timeouts, exponential backoff, and live telemetry on slash API health, telemetry, status, and SSE events."

---

### Scene 4 — Live Web Studio, Kanban DAG & Interactive App Preview (0:40.6 – 0:53.6 | 13.04s)
- **Captured Frame:** `demo-frames/frame4_kanban_preview.png` — Dependency-aware **Kanban Board** (`TASK-1`, `TASK-2`, `TASK-3` with expanded multi-agent audit trails) alongside the **Inspector** showing `app.js`, `brief.md`, `runbook.md`, `test.js`, and `index.html`.
- **Lower-Third Overlay:** `SCENE 04 / 06  |  DEPENDENCY-AWARE KANBAN & INSPECTOR — brief.md • runbook.md • app.js • test.js • index.html`
- **Spoken Narration:**
  > "At localhost forty-three twenty-one, tasks progress across a dependency-aware Kanban board with full audit history. Developers inspect brief, runbook, app dot J S, test dot J S, and index dot H T M L, and test the live app preview right in the studio."

---

### Scene 5 — Autonomous Self-Healing Rework Loop (`/api/swarm/rework`) (0:53.6 – 1:07.1 | 13.51s)
- **Captured Frame:** `demo-frames/frame5_rework_loop.png` — Self-Healing Rework Loop in action: `@verifier → @builder` red **`REWORK`** alert (`runtime:test.js ✗ — AssertionError [ERR_ASSERTION]: false == true` on SLA unit mismatch), internal `reasoning_content` trace, `@builder → @verifier` **`STEER`** patch (`slaHours * 3600e3`), and `test.js` verification suite (`5/5` suites, `8/8` assertions).
- **Lower-Third Overlay:** `SCENE 05 / 06  |  AUTONOMOUS SELF-HEALING REWORK — /api/swarm/rework • Pass 1 Bug -> Pass 2 5/5 Suites (8/8 Assertions)`
- **Spoken Narration:**
  > "Triggering slash API swarm rework injects a Pass-One unit-mismatch bug. Verifier runs Node test dot J S, catches the assertion error, moves Task One to rework, and steers Builder with the stack trace, self-healing all five suites and eight assertions on Pass Two."

---

### Scene 6 — `98/100 (VERIFIED_PASS)` Rubric, Live Steer & Cursor MCP Server (1:07.1 – 1:21.3 | 14.16s)
- **Captured Frame:** `demo-frames/frame6_rubric_mcp.png` — 100-Point Verification Rubric (`98/100 VERIFIED_PASS`: Correctness `25/25`, Test Coverage `24/25`, Architecture Adherence `25/25`, UI Completeness `24/25`), green sandbox checks (`syntax:app.js`, `syntax:test.js`, `runtime:test.js`, `artifact:index.html`), live steer (`/api/swarm/message`), CLI, and 4-tool Cursor MCP Server (`src/mcp-server.js`).
- **Lower-Third Overlay:** `SCENE 06 / 06  |  98/100 VERIFIED_PASS — 16,916 Tokens • 0 Errors • /api/swarm/message • 4-Tool Cursor MCP Server`
- **Spoken Narration:**
  > "The build scores ninety-eight out of one hundred, Verified Pass, across sixteen thousand nine hundred sixteen tokens with zero errors. With live specialist steering on slash API swarm message, a CLI, and a four-tool Cursor MCP server, MuseSwarm pushes the frontier."
