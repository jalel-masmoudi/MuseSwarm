# AGENTS.md — Muse Code & Multi-Agent Project Instructions

## Overview
**MuseSwarm** is a cross-platform multi-agent bot-to-bot collaboration engine built for the **Meta Global AI Developer Hackathon** (Theme 2: *Push the Frontier*, Indie Developer Track). It pairs Meta's `Muse Spark Open` (`meta-models/muse-spark-open-1026`) on Baseten (2M TPM) with `Muse Code` workflows, session messaging (`steer`, `queue`, `notify`), and Cursor IDE MCP tools.

## Architecture & Orchestration Contract
- **Session Message Bus (`src/swarm-engine.js`):** Enables live peer-to-peer messages (`@architect`, `@builder`, `@verifier`, `@lead`) on Windows, macOS, and Linux, bridging the Windows session-messaging gap in the native `muse` binary.
- **Auditable Kanban Board:** Every task transition (`ready` -> `in_progress` -> `rework` -> `done`) and cross-role comment is recorded in `.session.json` inside the generated workspace.
- **Sandbox Verification Loop:** `@verifier` runs `node --check` and `node test.js` on every artifact written by `@builder` and initiates an automated rework loop if any check fails.
