# Brief — On-Call Rotation & Burnout Fairness Scheduler

## Problem
Follow-the-sun handoffs drift when a scheduler stores local hours as UTC, and the same two people absorb every page.

## Target users
Engineering managers building a weekly rotation across time zones.

## Core behavior
- Convert a UTC shift start into each engineer’s local hour with an explicit `UTC±N` offset.
- Assign the handoff (default 09:00 local) to the eligible engineer with the lowest incident load.
- Load is severity-weighted (sev1 = 5, sev2 = 3, sev3 = 1).
- Jain’s fairness index below 0.85 moves one open shift from the busiest engineer toward the quietest.

## Files
- `domain.js` — offsets, scheduler, fairness, rebalance.
- `app.js` — isomorphic facade.
- `test.js` — handoff, fairness, and rebalance assertions.
- `index.html` — dark-mode roster.
