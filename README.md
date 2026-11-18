# MuseSwarm

[![CI](https://github.com/jalel-masmoudi/MuseSwarm/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jalel-masmoudi/MuseSwarm/actions/workflows/ci.yml)

MuseSwarm is a Node.js multi-agent code generator. Four LLM roles (`@architect`, `@builder`, `@verifier`, `@lead`) take a software request, plan it on a small Kanban board, write `app.js` / `index.html` / `test.js` into a workspace folder, run `node --check` and `node test.js` on the result, and loop back to `@builder` when a check fails. A web dashboard streams the session over SSE.

The model is Meta's Muse Spark Open (`meta-models/muse-spark-open-1026`) served through Baseten's OpenAI-compatible API. It was built for the Meta Global AI Developer Hackathon (Indie Developer track).

- Hosted demo (replay only, no model calls): https://museswarm.onrender.com
- Demo video: https://youtu.be/Iom-c3aXK4s

## Run it

Requires Node 22 (the version CI and the Docker image use). The server and CLI have no npm dependencies.

```bash
cp .env.example .env          # set BASETEN_API_KEY for live model calls
node src/cli.js doctor        # check the key and do one live handshake
npm run demo                  # one full session in the terminal (sprint-priority-engine scenario)
node src/cli.js run --scenario feature-flag-rollout
node src/cli.js run "Build a pomodoro tracker with unit tests"
npm start                     # dashboard on http://localhost:4321
npm test                      # unit, API and end-to-end tests (offline, no key needed)
```

Baseten tip: Muse Spark Open writes its reasoning (`reasoning_content`) before the answer, so set `max_tokens` to at least 1500 on any non-trivial call or the reply can run out before the JSON or code starts.

Generated projects land in `workspaces/<slug>-<id>/` together with `.session.json` (messages, Kanban history, file revisions, verification runs) and `benchmark.json`. `workspaces/sprint-priority-engine-8z24/` is an older committed reference run.

The dashboard is a React app in `museswarm-studio/`. A prebuilt bundle is committed in `public/`. To rebuild it: `cd museswarm-studio && npm ci && npm run build` (the server prefers `museswarm-studio/dist` when it exists).

### MCP server

`src/mcp-server.js` is a stdio JSON-RPC MCP server with four tools: `muse_swarm_list_agents`, `muse_swarm_ask_agent`, `muse_swarm_cobuild` and `muse_swarm_telemetry`. To use it from an MCP client such as Cursor or Claude Desktop, register it with:

```json
{ "mcpServers": { "muse-swarm": { "command": "node", "args": ["src/mcp-server.js"] } } }
```

The dashboard calls the same tools over `POST /api/mcp/invoke` with `{ "tool": "...", "arguments": {} }`.

## Architecture

```
src/
  cli.js              terminal entry point (doctor, peers, run, benchmark)
  server.js           HTTP server: REST API, SSE event stream, workspace preview, static UI
  mcp-server.js       stdio MCP server exposing the engine as tools
  swarm-engine.js     MuseSwarmEngine: sessions, message bus, Kanban, the four-stage pipeline and rework loop
  roles.js            role profiles and loading of profiles/<role>/SOUL.md system prompts
  prompts.js          per-role user prompts and the fallback plans used when a reply can't be parsed
  workspace.js        workspace writes, file history, write protection, sandbox test runs, session snapshots
  rework-diff.js      line diff used to record Pass 1 -> Pass 2 rework patches
  fallback-artifacts.js  offline app/test/html used when no usable model output exists
  baseten-client.js   OpenAI-compatible client: retries, timeouts, token/latency telemetry, offline replies
  reply-parser.js     extracts JSON and file patches from model replies
  scenarios.js        three preset scenarios with fixture code, tests and an injectable Pass 1 fault
  isolated-grade.js   grades a model-written domain.js in a separate child process
  public-demo.js      replay mode for the hosted demo: golden sessions, rate limits, workspace cleanup
  test-e2e.js         test suite run by `npm test`
```

A session runs four stages:

1. `@architect` returns a JSON plan (`brief.md`, `runbook.md`, Kanban tasks).
2. `@builder` returns the files as JSON. They are written to the workspace.
3. The engine runs `node --check` on every `.js` file and runs `node test.js`. On failure, `@builder` gets the output and patches only the failing files, up to `MUSE_SWARM_MAX_REWORK` times (default 2). In scenario runs `test.js` is read-only, and a model patch must also pass an isolated grade against the fixture. If the model can't fix it, the engine restores the known-good source and records that as `healedBy: deterministic_restore`.
4. The engine computes a 100-point rubric from the test results and code, `@verifier` reviews it, and `@lead` writes `README.md`.

Every write records who produced it (`model`, `offline_fixture`, `scenario_fixture`, `deterministic_restore`, `engine_fallback`, ...) so the session shows what the model actually wrote.

## What is real and what is demo

- **Live mode** (`BASETEN_API_KEY` set): every role is a real Muse Spark Open call, and the tests run as real child processes.
- **Offline mode** (no key, `MUSE_SWARM_OFFLINE=1`, or `npm test`): model replies are canned. Generated code comes from fixtures, so the pipeline, verification and rework loop run end to end, but no model output is involved.
- **Scenarios** (`sprint-priority-engine`, `feature-flag-rollout`, `oncall-fairness-scheduler`) use engine-owned fixture tests. The "self-heal" demo deliberately injects one known bug into Pass 1 (`simulateBrokenFirstPass` or `POST /api/swarm/rework`).
- **Hosted demo** (`MUSE_SWARM_PUBLIC_DEMO=1`) never calls Baseten. It replays three recorded live sessions in `workspaces/golden-*`. In two of them (sprint, feature flags) the model's own patch fixed the injected bug. In the third (on-call), the model's patch failed the tests and the engine restored the fixture. New runs on the hosted demo are offline-only and rate-limited.

## Deploy

`Dockerfile` (Node 22 Alpine, non-root, healthcheck on `/api/health`), `render.yaml` and `fly.toml` run the server in public-demo mode. It needs a long-lived process because it holds SSE connections, writes to `workspaces/` and spawns test processes.

## License

MIT, see `LICENSE`.
