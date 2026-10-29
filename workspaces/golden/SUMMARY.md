# PR #4 35479ac live verification (2026-10-29, 13:10-13:14 Tunis time)
Tree /workspace/muse-swarm-pr4-35479ac: 115/115 blobs byte-match the tree at 35479acd2f38. Fresh server pid 216968 on :4321.
Tests: node --check 11/11 OK; offline suite (no key, forced offline) 45 PASS exit 0; suite with key 45 PASS exit 0 (15s), including 10.1-10.7.

| | sprint swarm-mvti4gn7-bvy7 | flags swarm-mvti5hti-fxhd | oncall swarm-mvti6mtl-feo0 |
|---|---|---|---|
| verdict/score | VERIFIED_PASS 98 | VERIFIED_PASS 98 | VERIFIED_PASS 98 |
| runs | #1 FAIL, #2 PASS (model) | #1 FAIL, #2 PASS (model) | #1 FAIL, #2 FAIL (model), #3 PASS (deterministic_restore) |
| healedBy | model | model | deterministic_restore |
| model wrote domain.js | yes (rework; byte-identical to the clean fixture) | yes (same) | yes, but REJECTED by the tests (flipped the sort direction) |
| fault line in shipped domain.js | absent | absent | absent (engine restore) |
| test.js / app.js vs fixture | identical / identical | identical / identical | identical / identical |
| index.html | model-written (not graded) | model-written | model-written |
| rejected_* | app.js rejected_contract (build) | app.js rejected_contract (build) | app.js rejected_contract (build) |
| fixtures + shipped domain.js grade | PASS | PASS | PASS |
| lead / build / rework finishReason | stop / stop / stop | stop / stop / stop | stop / stop / stop |
| per-session telemetry | 5 calls, 16,669 tok | 5 calls, 19,288 tok | 5 calls, 21,790 tok |
| GOLDEN RUN? | YES | YES | NO (model heal failed; engine restore healed it) |

Oncall: the model's rework fixed the timezone fault but reintroduced the old ascending-sort bug (busiest = ranked[0] after an ascending sort). The new fixture direction test caught it ("highest incident load (bao=10) is the busiest: 'chi' !== 'bao'"), and the engine restored the clean fixture. See oncall-fairness-scheduler/domain.model-rework.diff.
