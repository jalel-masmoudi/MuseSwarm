# Runbook — Feature Flag & Canary Rollout Controller

## Contract
- `fnv1a(text)` returns an unsigned 32-bit FNV-1a hash.
- `defineFlag({ key, percentage, errorThreshold, minSamples })` clamps percentage to 0..100.
- `bucket(key, subjectId)` is pure for a given flag state. Percentage `0` enrolls nobody. Percentage `100` enrolls every bucket `0..99`.
- `recordOutcome(key, { error })` increments samples and, when the rate crosses the threshold, rolls the flag back.
- Rollback uses `>=`, so a rate that lands exactly on the threshold trips.

## Do not
- Do not invert the circuit comparison.
- Do not use `Math.random` for enrollment.
- Do not add npm dependencies.
