# Real-Time Engineering Sprint & Incident Priority Engine

A real-time priority engine for engineering sprints that ranks sprint items and incidents using weighted impact/urgency/effort scoring with an SLA breach detector that automatically boosts breached incidents to the top of the queue.

## Features
- Weighted impact/urgency/effort scoring for intelligent prioritization
- SLA breach detector using elapsed minutes against SLA budget
- SLA boost that raises score only after minute budget is spent
- Real-time sprint item storage and ranking
- Summary counts separating open work from completed items
- Input validation rejecting empty titles and unknown ids

## Files
- `brief.md` - Project brief and requirements
- `runbook.md` - Operational runbook
- `index.html` - Web UI for the priority engine
- `domain.js` - Core domain logic and scoring engine
- `app.js` - Application wiring and workspace integration
- `test.js` - Verification tests for scoring and SLA logic

## Run
- `node test.js` - Run verification tests
- `open index.html` - Launch the workspace in browser