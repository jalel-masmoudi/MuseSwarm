# Runbook — On-Call Rotation & Burnout Fairness Scheduler

## Contract
- Time zones are `UTC`, `UTC+N`, or `UTC-N` only.
- `localHour(utcIso, timezone)` is `(utcHour + offset + 48) % 24`.
- `assignShift({ startUtc, handoffLocalHour })` prefers engineers whose local hour equals the handoff hour, then the lowest load, then id.
- `fairnessIndex()` is Jain’s index over incident loads. Equal non-zero loads score 1. An empty load scores 1.
- `rebalance()` is a no-op at or above 0.85. Below that it retargets one open shift.

## Do not
- Do not drop the timezone offset and compare raw UTC hours.
- Do not add npm dependencies.
