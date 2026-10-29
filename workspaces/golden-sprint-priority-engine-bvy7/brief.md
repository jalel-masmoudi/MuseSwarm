# Brief — Sprint & Incident Priority Engine

## Problem
Engineering leads mix feature work and live incidents in one queue. A single unsorted list hides SLA breaches and over-weights easy tasks.

## Target users
Incident commanders and sprint leads who need a ranked queue during a live shift.

## Core behavior
- Score each item as `((impact × 1.6) + (urgency × 1.4)) / sqrt(effort)`.
- When elapsed minutes reach the SLA, add a fixed boost so the breach outranks healthy work of similar size.
- Completing an item drops it out of the breach list without deleting history.

## Files
- `domain.js` — `TaskPriorityEngine` scoring and SLA rules.
- `app.js` — isomorphic facade (`module.exports` and `globalThis.AppCore`).
- `test.js` — Node `assert` suite.
- `index.html` — dark-mode queue you can extend in the browser.
