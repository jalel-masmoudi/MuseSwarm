# Real-Time Engineering Sprint & Incident Priority Engine — Brief

## Problem
Engineering teams juggle incidents + feature work with no consistent prioritization. Ad-hoc triage causes SLA breaches, sprint overload, and low-impact work crowding out critical fixes. Need a transparent, weighted engine that scores every item and surfaces SLA risk in real-time.

## Features
1. **Weighted Priority Scoring:** Inputs `impact(1-5)`, `urgency(1-5)`, `effort(1-5, 5=hardest)`. Live score 0-100.
2. **Tier Classification:** `Critical ≥85 | High ≥70 | Medium ≥50 | Low <50` with color badges.
3. **SLA Detector:** Tier → SLA window: Critical 4h, High 8h, Medium 24h, Low 72h. Status: `OK (<75% elapsed) | WARNING (75-99%) | BREACH (≥100%)`. Shows deadline, remaining, elapsed%.
4. **Sprint Planner:** Rank backlog desc by score (tie-breaker: earliest `createdAt`), greedily fill sprint until `capacity` (sum effort) exceeded.
5. **Interactive Dark-Mode UI:** Add/edit/delete items, sliders with live preview, sortable table, SLA countdown, sprint lane, capacity bar. Zero-dependency, works via `file://`.
6. **Isomorphic Core:** All logic in `app.js` usable in Node & browser.

## SLA / Core Logic
**Score Formula (default weights `wI=0.5, wU=0.3, wE=0.2`, sum=1):**
```
effortInv = 6 - effort // 5→1, 1→5
raw = impact*wI + urgency*wU + effortInv*wE // 1..5
score = round((raw / 5) * 100) // 20..100
```
Custom `weights` allowed; normalize if sum≠1. Validate 1-5 integers else throw.

**SLA:**
```
deadline = new Date(createdAt.getTime() + SLA_WINDOW[tier])
elapsedPct = (now - createdAt) / (deadline - createdAt) *100
status = elapsedPct>=100 ? BREACH : elapsedPct>=75 ? WARNING : OK
remainingMs = deadline - now
```
`createdAt` accepts Date/ISO/number. `now` injectable for tests.

**Ranking & Sprint:**
- `rankBacklog(items)` pure, non-mutating, stable sort.
- `planSprint(ranked, capacity)` returns `{selected, totalEffort, remainingCapacity, skipped}`.