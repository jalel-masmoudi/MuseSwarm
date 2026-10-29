# MuseSwarm — Official 85-Second Hackathon Demo Video Script (v2)

- **Project:** MuseSwarm — Multi-Agent Bot-to-Bot Software Engineering Platform
- **Hackathon:** Meta Global AI Developer Hackathon (`$1,000,000` Prize Pool)
- **Track & Theme:** Indie Developer Track • Theme 2: *Push the Frontier* (Software Challenge)
- **Model & Inference Stack:** Meta `Muse Spark Open` (`meta-models/muse-spark-open-1026`, 816B total / 42B active MoE, 1M context) on **Baseten** (`https://inference.baseten.co/v1`, up to `2,000,000 TPM`) + **Meta Muse Code CLI** (`AGENTS.md`, `SOUL.md`, `.agents/memory`, `.muse/hooks.json`) + **Cursor IDE MCP Server** (`src/mcp-server.js`).
- **Output Video:** `museswarm-demo-v2.mp4` — `1920x1080`, 30 fps, H.264 High `yuv420p` + AAC-LC 44.1 kHz stereo, **84.76 seconds** across 6 timed scenes. Each still gets an eased Ken Burns push toward the feature it narrates, a `SCENE 0X / 06` lower third, and a neural TTS voiceover (`en-US-AndrewNeural`, +15% rate).
- **Capture source:** the new MuseSwarm Studio (judge experience UI) served by `node src/server.js` at `http://localhost:4321`, driven by Playwright through real runs. No `BASETEN_API_KEY` was configured for this capture, so the header reads `DEMO SIMULATION` and every number on screen comes from the backend's deterministic offline run of the same pipeline.
- **Frames:** `demo-frames/frame1.png` … `demo-frames/frame6.png` (all `1920x1080`). Frames 4 and 6 place two real Inspector / MCP drawer captures from the same run side by side under the Studio header. Frame 5 hides the Peer Agents and Kanban columns and wraps diff lines so the full Pass 1 and Pass 2 lines fit on screen.

---

## Scene-by-Scene Breakdown & Exact Voiceover Narration

### Scene 1 — MuseSwarm Studio, Judge Proof Strip & Judge Scenarios (0:00.00 – 0:14.00 | 14.00s)
- **Captured Frame:** `demo-frames/frame1.png` — Studio landing view: header (`meta-models/muse-spark-open-1026`, `DEMO SIMULATION`, `0 / 2,000,000 TPM`, `MCP Bridge`), the **Judge proof** strip (Meta Global AI Developer Hackathon · Theme 2 · Push the Frontier, Baseten `inference.baseten.co/v1`, per-agent `reasoning_content` slots), and the three **Judge scenarios** cards loaded from `GET /api/scenarios` (Sprint & Incident Priority Engine, Progressive Feature Flag & Canary Rollout Controller, On-Call Rotation & Burnout Fairness Scheduler).
- **Motion:** 1.00× → 1.12× push toward the proof strip and scenario cards.
- **Lower-Third Overlay:** `SCENE 01 / 06  |  MUSESWARM STUDIO — Judge Proof Strip + 3 One-Click Judge Scenarios (GET /api/scenarios)`
- **Spoken Narration:**
  > "Single-agent coding tools drift in scope or ship untested code. Meet MuseSwarm Studio. A judge proof strip pins Muse Spark Open ten-twenty-six on Baseten, and three judge scenarios load from slash API scenarios, one click each."

---

### Scene 2 — Session Bus, reasoning_content, SOUL.md & Kanban (0:14.00 – 0:27.77 | 13.77s)
- **Captured Frame:** `demo-frames/frame2.png` — After a one-click Feature Flag run: Peer Agents roster with `@architect`'s `SOUL.md` expanded, the dependency-aware Kanban (`TASK-1` → `TASK-2` → `TASK-3`, all `done`, audit trails), the **Session Bus** (`feature-flag-rollout-*`) showing `STEER`, `QUEUE` and `NOTIFY` handoffs with **Internal reasoning `reasoning_content`** expanded, and the Inspector file list.
- **Motion:** 1.00× → 1.28× push toward the Session Bus.
- **Lower-Third Overlay:** `SCENE 02 / 06  |  BOT-TO-BOT SESSION BUS — STEER / QUEUE / NOTIFY • reasoning_content • SOUL.md • Kanban audit`
- **Spoken Narration:**
  > "Four peer bots coordinate over a session bus with steer, queue, and notify handoffs. Every message keeps its reasoning content, each bot shows its soul dot M D, and tasks move across a dependency-aware Kanban board with a full audit trail."

---

### Scene 3 — Baseten 2M TPM Proof Strip with Session Telemetry (0:27.77 – 0:41.80 | 14.03s)
- **Captured Frame:** `demo-frames/frame3.png` — Proof strip after the Feature Flag run: `1,770 / 2,000,000 TPM`, `rolling 1,770 TPM · 0.09% of budget · reasoning 165 · 4 calls · 0 retries · 0 rework`, `sandbox node --check 3/3 · node test.js PASSED · 12 assertions`, per-agent `reasoning_content` row, header `97/100 VERIFIED_PASS`.
- **Motion:** 1.00× → 1.18× push onto the proof strip.
- **Lower-Third Overlay:** `SCENE 03 / 06  |  BASETEN 2M TPM PROOF STRIP — meta-models/muse-spark-open-1026 • node --check 3/3 • node test.js PASSED`
- **Spoken Narration:**
  > "The proof strip tracks each session against the two-million TPM budget: one thousand seven hundred seventy tokens over four calls, zero retries, node check three of three, and node test dot J S passing, straight from session telemetry."

---

### Scene 4 — Multi-File Workspace & Live App Preview (0:41.80 – 0:56.47 | 14.67s)
- **Captured Frame:** `demo-frames/frame4.png` — Two Inspector captures from the Feature Flag run: **Files** (`brief.md`, `runbook.md`, `app.js`, `test.js`, `verify-report.json`, `index.html`, `README.md`, `benchmark.json`, `domain.js`, with `domain.js` open on the FNV-1a hash and `FeatureFlagController`) and **Live App** (the generated *Feature Flag & Canary Rollout* UI: flag, percent, subject, Define / Check bucket / Record success / Record error).
- **Motion:** 1.00× → 1.10× centered push.
- **Lower-Third Overlay:** `SCENE 04 / 06  |  MULTI-FILE WORKSPACE — brief.md • runbook.md • domain.js • app.js • test.js • index.html + Live App`
- **Spoken Narration:**
  > "One click on the feature-flag rollout scenario builds a real multi-file workspace: brief, runbook, domain dot J S, app dot J S, test dot J S, and index dot H T M L, with the canary rollout app running live in the Inspector."

---

### Scene 5 — Self-Healing Diff Explorer, Pass 1 → Pass 2 (0:56.47 – 1:09.87 | 13.40s)
- **Captured Frame:** `demo-frames/frame5.png` — Sprint & Incident Priority Engine after **Simulate Broken Build → Self-Heal**: Session Bus `@verifier → @builder` **REWORK** card with the `node test.js` `AssertionError [ERR_ASSERTION]` stack trace, then `@builder → @verifier` STEER (`Rework #1 complete`). The Inspector **Self-Heal Diff** reads `Pass 1 · REWORK → Pass 2 · VERIFIED_PASS`, source `GET /api/session/:id/diffs · +1 −1`, split view on `domain.js`:
  - Pass 1 (red): `const slaBreached = elapsedMinutes >= slaMinutes * 60 * 1000; // pass-1 fault: minutes compared as milliseconds`
  - Pass 2 (green): `const slaBreached = elapsedMinutes >= slaMinutes;`
- **Motion:** 1.00× → 1.75× push onto the changed `slaBreached` lines.
- **Lower-Third Overlay:** `SCENE 05 / 06  |  SELF-HEALING DIFF EXPLORER — Pass 1 REWORK -> Pass 2 VERIFIED_PASS • GET /api/session/:id/diffs`
- **Spoken Narration:**
  > "Simulate Broken Build injects a Pass One fault. Verifier catches the assertion error and steers Builder with the stack trace. The Diff Explorer pins the exact line: minutes compared as milliseconds in red, the healed check in green."

---

### Scene 6 — 97/100 Verification Rubric & Cursor MCP Bridge (1:09.87 – 1:24.73 | 14.87s)
- **Captured Frame:** `demo-frames/frame6.png` — Header `5,548 / 2,000,000 TPM · 97/100 VERIFIED_PASS · 1 rework`. Left: Inspector **Verification** (`97/100 VERIFIED_PASS`; `syntax:domain.js`, `syntax:app.js`, `syntax:test.js`, `runtime:test.js`, `artifact:index.html` all pass; `node --check *.js && node test.js` output; Correctness `25/25`, Test Coverage `24/25`, Architecture Adherence `24/25`, UI Completeness `24/25`). Right: **Cursor MCP Bridge** drawer after invoking `muse_swarm_status` — `14 ms · POST /api/mcp/invoke`, the JSON-RPC 2.0 result, and the `.cursor/mcp.json` snippet.
- **Motion:** 1.00× → 1.14× push toward the MCP drawer.
- **Lower-Third Overlay:** `SCENE 06 / 06  |  97/100 VERIFIED_PASS • 1 REWORK — Cursor MCP Bridge: muse_swarm_status via POST /api/mcp/invoke (14 ms)`
- **Spoken Narration:**
  > "The build scores ninety-seven out of one hundred, Verified Pass, after one rework cycle. From the Cursor MCP Bridge drawer, muse swarm status answers over slash API M C P invoke in fourteen milliseconds. MuseSwarm pushes the frontier."
