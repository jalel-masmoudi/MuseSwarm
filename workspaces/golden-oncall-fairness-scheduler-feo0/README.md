# On-Call Rotation & Burnout Fairness Scheduler

Timezone-aware on-call scheduler that balances incident load fairly across distributed teams — handoffs align to local mornings, Jain's fairness index tracks equity, and fatigue-triggered auto-rebalance prevents burnout.

## Features
- Timezone-aware shift handoffs — rotations follow engineer local morning (e.g., 09:00 local)
- Load-balance fairness index — Jain's index quantifies equity across incident counts
- Incident-fatigue auto-rebalance — moves open shifts from busiest to quietest when fatigue exceeds floor
- Roster validation — rejects bad timezones and empty rosters with clear errors
- Zero-dependency browser + Node core — runs via `index.html` and `domain.js`

## Files
- `brief.md` — product brief and requirements
- `runbook.md` — operational runbook for on-call setup
- `index.html` — interactive scheduler UI
- `domain.js` — core domain logic (handoff, fairness, rebalance)
- `app.js` — app wiring and UI glue
- `test.js` — verification suite (6 tests)

## Run
- `node test.js` — run verification tests
- `open index.html` — launch interactive UI in browser