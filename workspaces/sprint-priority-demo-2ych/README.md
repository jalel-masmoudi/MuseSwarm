# Real-Time Engineering Sprint & Incident Priority Engine

> **Weighted Impact / Urgency / Effort Scoring + SLA Breach Detection + Real-Time Dark-Mode UI**
> An isomorphic priority engine for engineering sprints and incident triage — built by MuseSwarm.

![Status](https://img.shields.io/badge/status-verified-success)
![Tests](https://img.shields.io/badge/tests-6%2F6%20passing-brightgreen)
![Stack](https://img.shields.io/badge/stack-Vanilla%20JS%20%7C%20Isomorphic-blue)
![UI](https://img.shields.io/badge/UI-Dark%20Mode%20%7C%20Real--Time-8A2BE2)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

### Live Demo
Just open `index.html` — no build step, no dependencies.

---

## ✨ Overview

Engineering teams drown in competing priorities: feature work vs. production incidents vs. tech debt. This engine provides a **deterministic, explainable scoring system** to rank every item in real-time and automatically surface SLA risks before they breach.

Built as an **isomorphic core module (`app.js`)** that powers both the interactive browser UI (`index.html`) and Node.js verification suite (`test.js`) from a single source of truth.

**Verified Build:** All 6 verification tests passing, including weighted scoring, SLA boost, ranking, status transitions, and error handling.

## 🚀 Key Features

### 1. Weighted Priority Scoring
Every item is scored using a transparent formula balancing value vs. cost:

```
baseScore = (impact * w_impact + urgency * w_urgency) / effort
finalScore = baseScore * slaMultiplier
```

- **Impact (1-10):** Business/customer value if shipped
- **Urgency (1-10):** Time-sensitivity / incident severity
- **Effort (1-10):** Estimated engineering cost (inverse weight — lower effort = higher priority)
- **SLA Boost:** Automatic multiplier applied when an item is at-risk or breached

> Example from verification: Top-ranked item scored **24.09** after SLA boost — proving breach escalation correctly overrides base priority.

### 2. Real-Time SLA Breach Detector
- Configurable SLA deadline per item (hours/days)
- Three states: `OK` → `AT_RISK` (≤25% time remaining) → `BREACHED`
- **Live polling** in the UI — badges update without refresh
- SLA boost ensures breached incidents rocket to the top of the queue, even if effort is high

### 3. Interactive Dark-Mode UI (`index.html`)
- **Zero-dependency, single-file UI** — open and run
- Add / edit / transition items (Todo → In Progress → Done)
- Real-time ranked queue with score breakdowns
- SLA countdown timers + color-coded breach indicators (green / amber / red)
- Dark-mode first design, responsive, accessible
- Filters by status, type (Sprint Task / Incident / Tech Debt), and SLA state
- Summary metrics dashboard: total items, breached count, at-risk count, avg priority

### 4. Isomorphic Core Module (`app.js`)
Works identically in **Browser (via `<script>`) and Node.js (via `require`/`import`)**:

- `createEngine()` / `SprintEngine` — factory for isolated engine instances
- `addItem({ title, impact, urgency, effort, slaHours, type })` — with validation
- `calculateScore(item)` — pure weighted scoring function
- `getRankedQueue()` — sorted descending by `finalScore`
- `checkSLA(item)` / `detectBreaches()` — real-time detector
- `updateStatus(id, newStatus)` — state machine with metrics update
- `getSLASummary()` — aggregated metrics for dashboards
- Full input validation & error handling for unknown IDs

### 5. Status & Metrics
- Kanban-style transitions with SLA summary recalculation
- Metrics verified: breach counts and status distributions update correctly on transition

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│  index.html (Dark-Mode UI)                  │
│  - Form + Queue Renderer + SLA Poller       │
│  - Dashboard Metrics                        │
└──────────────┬──────────────────────────────┘
               │ <script src="app.js">
┌──────────────▼──────────────────────────────┐
│  app.js (Isomorphic Core)                   │
│  - Scoring Engine (pure functions)          │
│  - SLA Detector (time-aware)                │
│  - Store + Validation + Ranking             │
│  - UMD / ESM / CJS compatible               │
└──────────────┬──────────────────────────────┘
               │ require('./app.js')
┌──────────────▼──────────────────────────────┐
│  test.js (Verification Suite)               │
│  - 6 deterministic tests                    │
│  - Node.js assert, no external deps         │
└─────────────────────────────────────────────┘

Supporting Docs:
brief.md    → Product requirements & scoring spec
runbook.md  → Operational runbook for on-call / sprint master
```

**Design Principles:**
- **Single Source of Truth:** UI and tests import the *same* `app.js` — no logic duplication
- **Pure Functions First:** Scoring and SLA checks are deterministic and unit-testable
- **Explainable AI:** No black box — every score shows its weighted components
- **Fail-Safe:** Empty titles rejected, unknown IDs throw typed errors

## 📁 Project Structure

```
.
├── app.js        # Isomorphic core engine (scoring + SLA + store)
├── index.html    # Interactive dark-mode UI (real-time)
├── test.js       # Verification suite (6 tests, Node.js)
├── brief.md      # Product brief & requirements
├── runbook.md    # Operational runbook
└── README.md     # This file
```

## ⚡ Quick Start

### Option 1: Open the UI (Recommended)
No install needed.

1. Download / clone the project
2. Double-click `index.html` **or** run a local server:

```bash
# Python
python3 -m http.server 8000
# then open http://localhost:8000

# Node
npx serve .
# or
npx http-server -p 8000
```

3. Try it:
   - Add a Sprint Task: `Impact 8, Urgency 5, Effort 3, SLA 48h`
   - Add an Incident: `Impact 9, Urgency 10, Effort 2, SLA 4h`
   - Watch the Incident jump to #1 after SLA boost
   - Change status to `In Progress` → `Done` and see metrics update

### Option 2: Run the Core Engine in Node

```js
const { createEngine } = require('./app.js');

const engine = createEngine();
engine.addItem({
  title: "Fix payment webhook timeout",
  impact: 9,
  urgency: 10,
  effort: 3,
  slaHours: 4,
  type: "incident"
});

console.log(engine.getRankedQueue());
console.log(engine.getSLASummary());
console.log(engine.detectBreaches());
```

## 🧪 Running Tests

The verification suite is self-contained — no `npm install` required.

```bash
node test.js
```

**Expected Output:**
```
Running MuseSwarm Verification Suite...
[PASS] Test 1: Added items and calculated weighted priority + SLA boost scores
[PASS] Test 2: Real-time SLA breach detector verified
[PASS] Test 3: Priority ranking order with SLA boost verified (top score=24.09)
[PASS] Test 4: Status transition & SLA summary metrics verified
[PASS] Test 5: Input validation rejects empty titles
[PASS] Test 6: Error handling on unknown item ID verified
ALL 6 TESTS PASSED SUCCESSFULLY.
```

**Test Coverage:**
| Test | What It Verifies |
|------|------------------|
| 1 | Item creation + weighted score calculation with SLA multiplier |
| 2 | Time-aware SLA detector (OK / AT_RISK / BREACHED) |
| 3 | Ranking correctness — breached items outrank higher-effort tasks (24.09) |
| 4 | Status transitions + SLA summary metrics recalculation |
| 5 | Validation — empty/missing titles rejected |
| 6 | Error handling — unknown ID throws |

## 📖 API Reference

### `addItem(item)`
```js
engine.addItem({
  title: string,      // required, non-empty
  impact: number,     // 1-10
  urgency: number,    // 1-10
  effort: number,     // 1-10 (1 = trivial, 10 = massive)
  slaHours: number,   // hours until breach, e.g. 4, 24, 72
  type: string,       // "task" | "incident" | "debt" (optional)
  status: string      // "todo" | "in_progress" | "done" (default: todo)
});
// → { id, title, impact, urgency, effort, slaHours, createdAt, deadline, score, slaStatus }
```

### `getRankedQueue()`
Returns items sorted by `finalScore` descending. Breached items automatically boosted.

### `detectBreaches()` / `checkSLA(item)`
Evaluates `Date.now()` vs `deadline` and returns updated `slaStatus` + `slaMultiplier`.

### `updateStatus(id, newStatus)`
Transitions item and refreshes SLA summary. Throws if `id` not found.

### `getSLASummary()`
```js
{
  total: 5,
  breached: 1,
  atRisk: 2,
  ok: 2,
  avgScore: 14.32
}
```

## 🎨 UI Guide

- **Add Item Panel (left):** Sliders/inputs for Impact/Urgency/Effort + SLA deadline picker
- **Priority Queue (center):** Ranked cards with score badge, SLA countdown, and breakdown tooltip
- **Metrics Bar (top):** Live counts for Breached / At Risk / Total
- **Dark Mode:** Default — optimized for on-call dashboards and low-light war rooms

All updates are **real-time** — no save button needed. SLA timers tick every second.

## 📚 Docs

- **`brief.md`** — Original product brief: problem statement, scoring weights, SLA rules
- **`runbook.md`** — How to operate during sprint planning & incident triage: triage flow, SLA playbooks, escalation matrix

## 🛠️ Tech Stack

- **Vanilla JavaScript (ES2020)** — No frameworks, no build
- **Isomorphic UMD** — Browser + Node from one file
- **HTML5 + CSS3** — Custom dark-mode design system (CSS variables)
- **Node.js `assert`** — Native test runner

## 🚀 Deployment

This is a static app. Deploy anywhere:

- **GitHub Pages / Netlify / Vercel:** Drag & drop `index.html` + `app.js`
- **Internal Tooling:** Serve via `python -m http.server` on a shared VM
- **Electron/Tauri:** Wrap `index.html` for desktop on-call app

## 🤝 Contributing

1. Edit `app.js` (core logic)
2. Verify with `node test.js` (must stay 6/6)
3. Refresh `index.html` to see UI changes

---

**Built with ❤️ by MuseSwarm** — *Architect → Builder → Verifier → Lead*

> For questions, see `runbook.md` or open `index.html` and break some SLAs (safely).