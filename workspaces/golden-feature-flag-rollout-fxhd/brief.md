# Brief — Feature Flag & Canary Rollout Controller

## Problem
Percentage rollouts that call `Math.random()` reshuffle users on every request, and canaries that only page a human still ship a bad build to the rest of the cohort.

## Target users
Backend and frontend owners running a progressive rollout.

## Core behavior
- Bucket `fnv1a(flag + ':' + subject) % 100`. A subject is enrolled when `bucket < percentage`.
- Record canary outcomes. When samples reach `minSamples` and `errors / samples >= errorThreshold`, set `rolledBack` and force the percentage to 0.

## Files
- `domain.js` — hash, controller, circuit breaker.
- `app.js` — isomorphic facade.
- `test.js` — deterministic hash, enrollment, and rollback assertions.
- `index.html` — dark-mode rollout simulator.
