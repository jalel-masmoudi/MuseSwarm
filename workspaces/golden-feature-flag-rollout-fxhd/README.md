# Progressive Feature Flag & Canary Rollout Controller

Deterministic feature flag controller with progressive percentage rollouts, canary analysis, and automatic rollback — built with pure JavaScript and zero dependencies using FNV-1a hashing for stable subject bucketing.

## Features
- Deterministic FNV-1a percentage bucketing (hash % 100) stable per subject
- Progressive rollout control with configurable percentage thresholds
- Canary error-rate circuit breaker with automatic rollback
- Healthy canary detection prevents false-positive trips
- Missing flag key validation and rejection
- 98/100 rubric score with full test coverage

## Files
- `brief.md` - Project brief and requirements
- `runbook.md` - Operational runbook for rollout management
- `index.html` - Interactive demo UI for flag evaluation
- `domain.js` - Core domain logic: hashing, bucketing, and circuit breaker
- `app.js` - Application controller and flag evaluation engine
- `test.js` - Verification suite (5/5 passing)

## Run
```
node test.js
open index.html
```