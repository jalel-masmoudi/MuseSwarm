# Runbook

## Module Contracts
1. `app.js` exports `TaskPriorityEngine` with `addItem`, `getRankedItems`, `completeItem`, `getSlaBreaches`, and `getSummary`.
2. `index.html` loads `app.js` and renders interactive priority cards.
3. `test.js` validates normal ranking, SLA breach detection, status transitions, and input validation edge cases.