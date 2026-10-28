# Runbook — Sprint & Incident Priority Engine

## File Contracts

### `app.js` — Isomorphic Core (TASK-1)
**Exports:** `module.exports = App` (Node) + `window.App = App` (browser). No DOM, no deps.
```js
App = {
  SLA_WINDOW: {Critical:4*3600000, High:8*3600000, Medium:24*3600000, Low:72*3600000},
  DEFAULT_WEIGHTS: {impact:0.5, urgency:0.3, effort:0.2},
  calculatePriority({impact,urgency,effort,weights}) => {score, tier, breakdown:{raw,effortInv,weights}},
  classifyTier(score) => tier,
  getSLADeadline(createdAt, tier) => Date,
  getSLAStatus(item, now?) => {deadline, status, remainingMs, elapsedPct, tier, score},
  rankBacklog(items) => sortedCopy,
  planSprint(backlog, capacity) => {selected, totalEffort, remainingCapacity},
  createItem({title,impact,urgency,effort,type?,createdAt?}) => item,
  validateItem(item) => void|throw
}
```
**Acceptance:** Pure functions, throws on invalid 1-5, handles Date/ISO/number, normalized weights, 20-100 score range.

### `index.html` — Dark-Mode UI (TASK-1)
Single file, inline CSS/JS, loads `app.js` via `<script src="app.js">`. Must reuse `App` (no logic duplication).
UI: header + form (title, impact/urgency/effort sliders 1-5 + live score/tier preview), SLA legend, controls (capacity input, sort, filter), backlog table (rank, title, score badge, tier, SLA status+countdown, effort, actions), sprint lane + capacity bar.
Dark theme by default, responsive, accessible. Zero CDN.

### `test.js` — Unit Tests (TASK-2)
Node-only, `const App=require('./app.js'); const assert=require('assert');` No deps. Tests all App APIs, prints `PASS/FAIL` per case, exits 0/1. Runnable `node test.js`.

## Kanban
- **TASK-1 @builder:** Implement `app.js` + `index.html` per contracts. Verify `node -e "require('./app.js')"` and open `index.html`.
- **TASK-2 @verifier:** Implement `test.js` covering invariants/edges, run `node test.js`, fix contract drift.

## Do NOT Rules
- Do NOT add npm deps, package.json, fetch, CDN, build step.
- Do NOT duplicate scoring/SLA logic in `index.html`; import from `app.js`.
- Do NOT mutate inputs in `rankBacklog/planSprint`.
- Do NOT use localStorage as source of truth (optional cache only).
- Do NOT write code in `brief.md/runbook.md`.