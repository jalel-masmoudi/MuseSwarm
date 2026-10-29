# Runbook — Sprint & Incident Priority Engine

## Layout
1. `domain.js` exports `TaskPriorityEngine`.
2. `app.js` re-exports it for Node and assigns `globalThis.AppCore`.
3. `index.html` loads `domain.js` then `app.js`.
4. `test.js` requires `./app.js` and prints `[PASS]` lines.

## Contract
- `addItem({ title, impact, urgency, effort, slaMinutes, elapsedMinutes })` clamps impact/urgency/effort to 1..10.
- `slaBreached` is `elapsedMinutes >= slaMinutes`. Both values are minutes.
- `getRankedItems` sorts by score descending.
- `getSlaBreaches` returns open items that have already breached.
- Empty titles and unknown ids throw.

## Do not
- Do not compare minutes to milliseconds.
- Do not add npm dependencies.
