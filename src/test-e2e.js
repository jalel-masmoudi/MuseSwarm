// Force simulated replies for this process even if a .env BASETEN_API_KEY is present.
// Tests that pass apiKey + fetchImpl still exercise the live HTTP path with mocks.
process.env.MUSE_SWARM_OFFLINE = '1';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { CONFIG } = require('./config');
const { BasetenMuseClient, computePercentile } = require('./baseten-client');
const { MuseSwarmEngine, AGENT_PROFILES, extractJsonBlock, SCENARIO_PRESETS, buildReworkDiff } = require('./swarm-engine');
const { TOOLS } = require('./mcp-server');
const { server, engine: httpEngine, normalizeAgentId } = require('./server');
const { extractFilePatch } = require('./reply-parser');
const { buildScenarioArtifacts, applyPass1Fault, applyOnCallAscendingBusiestFault } = require('./scenarios');
const {
  createRateLimiter,
  createConcurrencyGate,
  goldenCatalog,
  isGoldenSession,
  buildReplayEvents,
} = require('./public-demo');

async function testBasetenClientTelemetryAndRetry() {
  console.log('\n--- [Suite 1] BasetenMuseClient Telemetry, Percentile & Retry/Timeout Tests ---');

  // 1. Percentile calculation
  assert.strictEqual(computePercentile([100, 200, 300, 400, 500], 50), 300, 'p50 of 100..500 should be 300');
  assert.strictEqual(computePercentile([100, 200, 300, 400, 500], 95), 500, 'p95 of 100..500 should be 500');
  console.log('[PASS] 1.1: Latency percentile computation (p50 / p95)');

  // 2. Rolling 2M TPM window & reasoning token extraction
  let callIndex = 0;
  const mockFetch = async () => {
    callIndex += 1;
    if (callIndex === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '0.02' : null) },
        text: async () => 'Rate limit exceeded, retry shortly',
      };
    }
    if (callIndex === 2) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => 'Upstream temporarily busy',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-test-123',
        model: 'meta-models/muse-spark-open-1026',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: '{"ok":true}',
              reasoning_content: 'Evaluated system invariants and verified contract.',
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 180,
          total_tokens: 300,
          completion_tokens_details: { reasoning_tokens: 80 },
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
    };
  };

  const client = new BasetenMuseClient({
    apiKey: 'test_baseten_valid_key_12345',
    maxRetries: 3,
    retryBaseDelayMs: 15,
    fetchImpl: mockFetch,
  });

  const res = await client.chatCompletion({
    agentId: 'architect',
    messages: [{ role: 'user', content: 'Test retry and telemetry' }],
  });

  assert.strictEqual(callIndex, 3, 'Should succeed on 3rd attempt after 429 and 503 retries');
  assert.strictEqual(client.retryCount, 2, 'Should record 2 retries');
  assert.strictEqual(res.reasoningContent, 'Evaluated system invariants and verified contract.');
  assert.strictEqual(res.usage.totalTokens, 300);
  assert.strictEqual(res.usage.reasoningTokens, 80);
  assert.strictEqual(res.usage.cachedTokens, 40);

  const tel = client.getTelemetry();
  assert.strictEqual(tel.currentTpm, 300, 'Rolling TPM should reflect 300 tokens');
  assert.strictEqual(tel.totalReasoningTokens, 80, 'Should track reasoning tokens');
  assert.strictEqual(tel.agentBreakdown.architect.calls, 1, 'Per-agent breakdown should record architect call');
  console.log('[PASS] 1.2: Retry/backoff on HTTP 429 & 503 + reasoning_content & 2M TPM rolling telemetry');

  const bodies = [];
  const effortFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning_effort) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => 'Unknown parameter: reasoning_effort',
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: 'ok-no-effort',
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
  };
  const effortClient = new BasetenMuseClient({
    apiKey: 'test_baseten_valid_key_12345',
    maxRetries: 2,
    retryBaseDelayMs: 5,
    fetchImpl: effortFetch,
  });
  const effortRes = await effortClient.chatCompletion({
    agentId: 'lead',
    messages: [{ role: 'user', content: 'short release' }],
    reasoningEffort: 'low',
  });
  assert.strictEqual(bodies[0].reasoning_effort, 'low');
  assert.ok(!Object.prototype.hasOwnProperty.call(bodies[1], 'reasoning_effort'));
  assert.strictEqual(effortRes.content, 'ok');
  assert.strictEqual(effortClient.reasoningEffortUnsupported, true);
  console.log('[PASS] 1.3: reasoning_effort is sent, then dropped for the rest of the run on a 400');

  const snapClient = new BasetenMuseClient({ apiKey: '', allowOfflineFallback: true, offline: true });
  const snapA = snapClient.snapshotUsage();
  await snapClient.chatCompletion({ agentId: 'verifier', messages: [{ role: 'user', content: 'a' }] });
  const mid = snapClient.telemetrySince(snapA);
  const snapB = snapClient.snapshotUsage();
  await snapClient.chatCompletion({ agentId: 'verifier', messages: [{ role: 'user', content: 'b' }] });
  const second = snapClient.telemetrySince(snapB);
  const all = snapClient.getTelemetry();
  assert.strictEqual(mid.totalCalls, 1);
  assert.strictEqual(second.totalCalls, 1);
  assert.strictEqual(all.totalCalls, 2);
  assert.strictEqual(second.agentBreakdown.verifier.calls, 1);
  assert.strictEqual(second.latencies.length, 1);
  assert.strictEqual(all.totalCalls, mid.totalCalls + second.totalCalls);
  console.log('[PASS] 1.4: telemetrySince scopes calls to the snapshot window');
}

async function testMessageBusAndKanbanDependencies() {
  console.log('\n--- [Suite 2] Bot-to-Bot Session Message Bus, Kanban Dependencies & Parallel Fan-Out ---');
  const engine = new MuseSwarmEngine();
  const session = engine.createSession({ prompt: 'Unit test session bus and kanban', projectName: 'unit-bus-test' });

  // Message bus delivery modes
  engine.postBotMessage(session, { from: 'architect', to: 'builder', delivery: 'steer', content: 'Steer msg' });
  engine.postBotMessage(session, { from: '@builder', to: '@verifier', delivery: 'queue', content: 'Queue msg' });
  engine.postBotMessage(session, { from: '@lead', to: '@all', delivery: 'notify', content: 'Broadcast msg' });

  const builderInbox = engine.getMessagesForAgent(session, '@builder');
  assert.strictEqual(builderInbox.length, 2, '@builder should receive direct message + @all broadcast');
  const steerOnly = engine.getMessagesForAgent(session, '@builder', 'steer');
  assert.strictEqual(steerOnly.length, 1, 'Filtered steer inbox for @builder should have 1 message');
  console.log('[PASS] 2.1: Bot-to-bot session message bus routing (steer / queue / notify & @all)');

  // Kanban dependency resolution
  engine.createKanbanTask(session, { id: 'T-1', title: 'Spec', assignee: '@architect' });
  engine.createKanbanTask(session, { id: 'T-2', title: 'Build', assignee: '@builder', dependsOn: ['T-1'] });

  let ready = engine.getReadyTasks(session);
  assert.strictEqual(ready.length, 1, 'Only T-1 should be ready before T-1 is done');
  assert.strictEqual(ready[0].id, 'T-1');

  engine.updateKanbanTask(session, 'T-1', { status: 'in_progress', author: '@architect' });
  engine.updateKanbanTask(session, 'T-1', { status: 'done', author: '@architect', comment: 'Spec complete' });

  ready = engine.getReadyTasks(session);
  assert.strictEqual(ready.length, 1, 'T-2 should become ready once T-1 is done');
  assert.strictEqual(ready[0].id, 'T-2');
  assert.strictEqual(session.kanban[0].history.length, 3, 'Task transition audit trail should record 3 states');
  console.log('[PASS] 2.2: Dependency-aware Kanban state transitions & audit history');

  // Parallel task fan-out
  const fanoutRes = await engine.runParallelTasks(
    session,
    [
      { id: 'mod-a', title: 'Module A', val: 10 },
      { id: 'mod-b', title: 'Module B', val: 20 },
      { id: 'mod-c', title: 'Module C', val: 30 },
    ],
    async (spec) => spec.val * 2
  );
  assert.strictEqual(fanoutRes.length, 3, 'Should execute 3 parallel subtasks');
  assert.deepStrictEqual(fanoutRes.map((r) => r.result), [20, 40, 60]);
  assert.strictEqual(session.parallelTasksRun.length, 1, 'Session should record parallel fan-out batch');
  console.log('[PASS] 2.3: Parallel module/task fan-out execution & telemetry');

  fs.rmSync(session.workspaceDir, { recursive: true, force: true });
}

async function testSelfHealingReworkLoop() {
  console.log('\n--- [Suite 3] Autonomous @verifier -> @builder Self-Healing Rework Loop ---');

  let builderCallCount = 0;
  const mockClient = new BasetenMuseClient({
    apiKey: 'mock_key_for_rework_test_12345',
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      const userContent = body.messages.find((m) => m.role === 'user')?.content || '';

      let replyJson = {};
      if (userContent.includes('User Software Request:')) {
        replyJson = {
          projectTitle: 'Rework Loop Test App',
          briefMd: '# Brief\nTest rework loop.',
          runbookMd: '# Runbook\nTest rework loop.',
          kanbanTasks: [
            { id: 'TASK-1', title: 'Build', assignee: '@builder' },
            { id: 'TASK-2', title: 'Verify', assignee: '@verifier', parentId: 'TASK-1' },
            { id: 'TASK-3', title: 'Lead', assignee: '@lead', parentId: 'TASK-2' },
          ],
          messageToBuilder: '@builder Implement app.js, index.html, test.js.',
          messageToVerifier: '@verifier Verify TASK-1.',
        };
      } else if (userContent.includes('You are @builder executing TASK-1')) {
        builderCallCount += 1;
        replyJson = {
          messageToArchitect: '@architect Initial build written.',
          messageToVerifier: '@verifier Ready for test.',
          files: {
            'app.js': 'module.exports = { add: (a, b) => a - b }; globalThis.AppCore = module.exports;',
            'index.html': '<!DOCTYPE html><html><body><button onclick="alert(1)">Run</button><script src="app.js"></script></body></html>',
            'test.js': 'const assert = require("assert"); const { add } = require("./app.js"); assert.strictEqual(add(2, 3), 5, "2+3 must equal 5"); console.log("[PASS] add test");',
          },
        };
      } else if (userContent.includes('Rework Attempt #1')) {
        builderCallCount += 1;
        replyJson = {
          messageToVerifier: '@verifier Fixed arithmetic bug in app.js (changed a - b to a + b).',
          files: {
            'app.js': 'module.exports = { add: (a, b) => a + b }; globalThis.AppCore = module.exports;',
            'test.js': 'const assert = require("assert"); const { add } = require("./app.js"); assert.strictEqual(add(2, 3), 5, "2+3 must equal 5"); console.log("[PASS] add test");',
          },
        };
      } else if (userContent.includes('You are @verifier auditing')) {
        replyJson = {
          verdict: 'VERIFIED_PASS',
          qualityScore: 95,
          messageToBuilder: '@builder Rework verified!',
          messageToLead: '@lead All green.',
        };
      } else {
        replyJson = {
          readmeMd: '# Rework Verified README',
          finalBroadcast: '@all Done!',
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'mock-rework',
          choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(replyJson) + '\n```', reasoning_content: 'Reasoning step' } }],
          usage: { prompt_tokens: 100, completion_tokens: 150, total_tokens: 250, completion_tokens_details: { reasoning_tokens: 50 } },
        }),
      };
    },
  });

  const engine = new MuseSwarmEngine({ client: mockClient });
  const session = engine.createSession({ prompt: 'Build adder module', projectName: 'rework-test' });
  await engine.executeSwarm(session);

  assert.strictEqual(builderCallCount, 2, '@builder should be called twice (initial build + 1 rework fix)');
  assert.strictEqual(session.reworkCycles, 1, 'Session should record 1 rework cycle');
  assert.strictEqual(session.verificationRuns.length, 2, 'Should have 2 verification runs (1st failed, 2nd passed)');
  assert.strictEqual(session.verificationRuns[0].passed, false, 'First verification run must fail');
  assert.strictEqual(session.verificationRuns[1].passed, true, 'Second verification run after rework must pass');
  assert.deepStrictEqual(
    session.verificationRuns.map((r) => [r.pass, r.phase]),
    [[1, 'pass1_initial'], [2, 'rework_verify']]
  );
  console.log('[PASS] 3.1: @verifier detected failing assertion, routed stack trace to @builder, and verified fix');

  const appDiff = session.reworkDiffs.find((entry) => entry.path === 'app.js');
  assert.ok(appDiff, 'Real rework must record an app.js unified diff');
  const removed = appDiff.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  const added = appDiff.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  assert.ok(removed.some((line) => line.includes('a - b')), 'Diff must remove the broken pass-1 line');
  assert.ok(added.some((line) => line.includes('a + b')), 'Diff must add the self-healed line');
  assert.ok(appDiff.beforeSnippet && appDiff.afterSnippet, 'Diff must include before/after snippets');
  assert.strictEqual(appDiff.source, 'model', 'A parsed non-simulated Baseten reply is credited to the model');
  assert.deepStrictEqual(session.reworkSummary.map((c) => c.healedBy), ['model']);
  assert.ok(session.fileHistory['app.js'].length >= 2, 'fileHistory must snapshot each app.js write');
  assert.strictEqual(session.files['app.js'].diff, appDiff.diff, 'Per-file diff string must match the rework diff');
  const serializedRework = engine.serializeSession(session);
  assert.ok(serializedRework.reworkDiffs.length >= 1 && serializedRework.fileHistory['app.js']);
  console.log('[PASS] 3.2: Pass 1 -> Pass 2 unified diff and fileHistory recorded on a real rework');

  fs.rmSync(session.workspaceDir, { recursive: true, force: true });
}

async function testServerEndpoints() {
  console.log('\n--- [Suite 4] HTTP API & Studio Endpoints (/api/status, /api/telemetry, /api/swarm/message, /api/swarm/rework) ---');

  if (typeof normalizeAgentId === 'function') {
    assert.strictEqual(normalizeAgentId('@architect'), 'architect');
    assert.strictEqual(normalizeAgentId('BUILDER'), 'builder');
    assert.strictEqual(normalizeAgentId('@verifier'), 'verifier');
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.strictEqual(statusJson.ok, true);
    assert.strictEqual(statusJson.scenarios.length, 3, 'GET /api/status must include the 3 scenario presets');
    console.log('[PASS] 4.1: GET /api/status returns agents, telemetry, sessions, and scenarios');

    const scenRes = await fetch(`${baseUrl}/api/scenarios`);
    assert.strictEqual(scenRes.status, 200);
    const scenJson = await scenRes.json();
    assert.deepStrictEqual(
      scenJson.scenarios.map((item) => item.id),
      ['sprint-priority-engine', 'feature-flag-rollout', 'oncall-fairness-scheduler']
    );
    assert.ok(scenJson.scenarios.every((item) => item.artifacts['domain.js'] && item.artifacts['index.html']));
    console.log('[PASS] 4.1b: GET /api/scenarios returns the 3 presets and their artifacts');

    const telRes = await fetch(`${baseUrl}/api/telemetry`);
    assert.strictEqual(telRes.status, 200);
    const telJson = await telRes.json();
    assert.strictEqual(telJson.status, 'healthy');
    console.log('[PASS] 4.2: GET /api/telemetry returns health and benchmark stats');

    const msgRes = await fetch(`${baseUrl}/api/swarm/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: '@architect', message: 'Verify API contract' }),
    });
    assert.strictEqual(msgRes.status, 200);
    const msgJson = await msgRes.json();
    assert.strictEqual(msgJson.ok, true);
    assert.strictEqual(msgJson.agent.handle, '@architect');
    assert.ok(!msgJson.reply.includes('```json'), 'Conversational @architect steer should be prose, not the JSON spec');
    assert.ok(!msgJson.reply.includes('kanbanTasks'));
    const specClient = new BasetenMuseClient({ apiKey: 'offline', allowOfflineFallback: true });
    const specRes = await specClient.chatCompletion({
      agentId: 'architect',
      messages: [{ role: 'user', content: 'User Software Request: "demo"\n\nReturn ONLY a valid JSON object inside a ```json code block' }],
    });
    const specJson = extractJsonBlock(specRes.content);
    assert.ok(specJson && Array.isArray(specJson.kanbanTasks), 'JSON spec prompt must still return the architect plan');
    console.log('[PASS] 4.3: POST /api/swarm/message normalizes @architect handle and returns a prose steer');

    const rwRes = await fetch(`${baseUrl}/api/swarm/rework`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
        projectName: 'api-rework-test',
        scenarioId: 'sprint-priority-engine',
        sync: true,
      }),
    });
    assert.strictEqual(rwRes.status, 200);
    const rwJson = await rwRes.json();
    assert.strictEqual(rwJson.ok, true);
    assert.strictEqual(rwJson.scenarioId, 'sprint-priority-engine');
    assert.strictEqual(rwJson.session.reworkCycles, 1, 'Should record 1 rework cycle');
    assert.strictEqual(rwJson.session.verificationRuns[0].passed, false, 'Fault-injected first pass must fail');
    assert.strictEqual(rwJson.session.verificationRuns.slice(-1)[0].passed, true, 'Self-healed rework pass must succeed');
    assert.deepStrictEqual(
      rwJson.session.verificationRuns.map((r) => [r.pass, r.phase, r.passed]),
      [[1, 'pass1_initial', false], [2, 'rework_verify', true]],
      '1 rework cycle must record exactly 1 failing + 1 passing verification'
    );
    assert.ok(rwJson.session.reworkDiffs.length >= 1, 'Rework response must include unified diffs');
    console.log('[PASS] 4.4: POST /api/swarm/rework executes fault injection -> self-healing verification');

    const diffRes = await fetch(`${baseUrl}/api/session/${rwJson.session.id}/diffs`);
    assert.strictEqual(diffRes.status, 200);
    const diffJson = await diffRes.json();
    assert.ok(diffJson.reworkDiffs.length >= 1);
    assert.ok(diffJson.fileHistory['domain.js'].length >= 2);
    const swarmDiffRes = await fetch(`${baseUrl}/api/swarm/diffs?sessionId=${encodeURIComponent(rwJson.session.id)}`);
    assert.strictEqual(swarmDiffRes.status, 200);
    const swarmDiffJson = await swarmDiffRes.json();
    assert.strictEqual(swarmDiffJson.reworkDiffs.length, diffJson.reworkDiffs.length);
    console.log('[PASS] 4.5: GET /api/session/:id/diffs and /api/swarm/diffs return reworkDiffs and fileHistory');

    const mcpRes = await fetch(`${baseUrl}/api/mcp/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'muse_swarm_list_agents', arguments: {} }),
    });
    assert.strictEqual(mcpRes.status, 200);
    const mcpJson = await mcpRes.json();
    assert.strictEqual(mcpJson.ok, true);
    assert.strictEqual(mcpJson.response.jsonrpc, '2.0');
    assert.ok(typeof mcpJson.latencyMs === 'number');
    assert.ok(mcpJson.response.result.content[0].text.includes('architect'));
    const mcpNameRes = await fetch(`${baseUrl}/api/mcp/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'muse_swarm_telemetry', args: {} }),
    });
    const mcpNameJson = await mcpNameRes.json();
    assert.strictEqual(mcpNameJson.ok, true);
    assert.ok(mcpNameJson.response.result.content[0].text.includes('telemetry'));
    console.log('[PASS] 4.6: POST /api/mcp/invoke returns the MCP JSON-RPC result and latency');

    const missingRes = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.strictEqual(missingRes.status, 404);
    assert.ok(String(missingRes.headers.get('content-type') || '').includes('application/json'));
    const missingJson = await missingRes.json();
    assert.strictEqual(missingJson.ok, false);
    assert.strictEqual(missingJson.error, 'not_found');
    assert.strictEqual(missingJson.path, '/api/does-not-exist');
    const rootRes = await fetch(`${baseUrl}/`);
    assert.strictEqual(rootRes.status, 200);
    assert.ok(String(rootRes.headers.get('content-type') || '').includes('text/html'));
    const rootBody = await rootRes.text();
    assert.ok(rootBody.includes('<div id="root">') || rootBody.toLowerCase().includes('<!doctype html'));
    console.log('[PASS] 4.7: unmatched /api/* returns JSON 404; GET / still serves HTML');

    if (rwJson.session?.workspaceDir && fs.existsSync(rwJson.session.workspaceDir)) {
      fs.rmSync(rwJson.session.workspaceDir, { recursive: true, force: true });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runFullSwarmE2E() {
  console.log('\n--- [Suite 5] Full End-to-End Multi-Agent Co-Build Session & Artifacts Verification ---');
  const engine = new MuseSwarmEngine();
  let session = null;

  try {
    session = engine.createSession({
      prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine with weighted impact/urgency/effort scoring, SLA detector, interactive dark-mode UI (index.html), isomorphic core module (app.js), and unit tests (test.js).',
      projectName: 'sprint-priority-demo',
    });

    await engine.executeSwarm(session);

    assert.strictEqual(session.status, 'completed', 'Session should complete');
    assert.ok(session.messages.length >= 6, 'Should exchange at least 6 bot-to-bot messages');
    assert.ok(session.files['brief.md'], 'Should generate brief.md');
    assert.ok(session.files['runbook.md'], 'Should generate runbook.md');
    assert.ok(session.files['app.js'], 'Should generate app.js');
    assert.ok(session.files['index.html'], 'Should generate index.html');
    assert.ok(session.files['test.js'], 'Should generate test.js');
    assert.ok(session.files['README.md'], 'Should generate README.md');
    assert.ok(session.files['domain.js'], 'Should generate domain.js for the sprint scenario');
    assert.ok(session.files['benchmark.json'], 'Should generate benchmark.json');
    assert.ok(fs.existsSync(path.join(session.workspaceDir, '.session.json')), 'Should persist .session.json snapshot');

    const lastVer = session.verificationRuns[session.verificationRuns.length - 1];
    assert.ok(lastVer && lastVer.passed, 'Sandbox verification run must pass');
    assert.ok(session.rubricEvaluation && session.rubricEvaluation.qualityScore >= 85, 'Rubric quality score should be >= 85');
    assert.strictEqual(TOOLS.length, 4, 'MCP server should expose 4 tools');
    console.log('[PASS] 5.1: Full 4-agent workflow (@architect -> @builder -> @verifier -> @lead) & benchmark.json verified');
    console.log('Rubric Score:', `${session.rubricEvaluation.qualityScore}/100 (${session.rubricEvaluation.verdict})`);
    console.log('Telemetry:', JSON.stringify(engine.client.getTelemetry()));

    httpEngine.sessions.set(session.id, session);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const workspaceSlug = path.basename(session.workspaceDir);
    const slugRes = await fetch(`${baseUrl}/preview/${encodeURIComponent(session.slug)}/index.html`);
    assert.strictEqual(slugRes.status, 200, `/preview/${session.slug}/index.html should return 200`);
    for (const key of [session.id, workspaceSlug]) {
      const previewRes = await fetch(`${baseUrl}/preview/${encodeURIComponent(key)}/index.html`);
      const previewBody = await previewRes.text();
      assert.strictEqual(previewRes.status, 200, `/preview/${key}/index.html should return 200`);
      assert.ok(previewBody.includes('Sprint & Incident Priority'), `/preview/${key}/index.html should serve this workspace`);
    }
    console.log(`[PASS] 5.2: /preview/${workspaceSlug}/index.html returns 200`);
  } finally {
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (session) {
      httpEngine.sessions.delete(session.id);
      fs.rmSync(session.workspaceDir, { recursive: true, force: true });
    }
  }
  assert.ok(session && !fs.existsSync(session.workspaceDir), 'Suite 5 must remove its temporary workspace');
}

async function testScenarioPresetsAndPassDiffs() {
  console.log('\n--- [Suite 6] Judge Scenario Presets & Pass 1 -> Pass 2 Diff Explorer ---');

  assert.strictEqual(SCENARIO_PRESETS.length, 3);
  assert.deepStrictEqual(
    SCENARIO_PRESETS.map((preset) => preset.id),
    ['sprint-priority-engine', 'feature-flag-rollout', 'oncall-fairness-scheduler']
  );

  const sample = buildReworkDiff({
    filePath: 'domain.js',
    before: 'const slaBreached = false; // pass-1 fault\n',
    after: 'const slaBreached = elapsedMinutes >= slaMinutes;\n',
    author: '@builder',
    reworkAttempt: 1,
  });
  assert.strictEqual(sample.passFrom, 1);
  assert.strictEqual(sample.passTo, 2);
  assert.ok(sample.diff.includes('\n-const slaBreached = false;'));
  assert.ok(sample.diff.includes('\n+const slaBreached = elapsedMinutes >= slaMinutes;'));
  assert.ok(sample.beforeSnippet && sample.afterSnippet);
  console.log('[PASS] 6.1: Unified diff marks removed broken lines and added healed lines');

  const detectEngine = new MuseSwarmEngine();
  const detected = detectEngine.createSession({
    prompt: 'Build an On-Call Rotation & Burnout Fairness Scheduler for follow-the-sun handoffs',
    projectName: 'detect-oncall',
  });
  assert.strictEqual(detected.scenarioId, 'oncall-fairness-scheduler');
  const explicit = detectEngine.createSession({
    prompt: 'unrelated prompt',
    scenarioId: 'feature-flag-rollout',
    projectName: 'explicit-flag',
  });
  assert.strictEqual(explicit.scenarioId, 'feature-flag-rollout');
  fs.rmSync(detected.workspaceDir, { recursive: true, force: true });
  fs.rmSync(explicit.workspaceDir, { recursive: true, force: true });
  console.log('[PASS] 6.2: scenarioId is explicit or auto-detected from the prompt');

  for (const preset of SCENARIO_PRESETS) {
    const engine = new MuseSwarmEngine();
    const session = engine.createSession({
      prompt: preset.prompt,
      scenarioId: preset.id,
      projectName: `${preset.id}-e2e`,
      simulateBrokenFirstPass: true,
    });
    try {
      await engine.executeSwarm(session);
      for (const relPath of ['brief.md', 'runbook.md', 'domain.js', 'app.js', 'test.js', 'index.html', 'README.md', 'benchmark.json']) {
        assert.ok(session.files[relPath], `${preset.id} should write ${relPath}`);
      }
      assert.ok(session.files['index.html'].content.includes('#0b0f19'), `${preset.id} preview should be dark-mode`);
      assert.ok(/<button/i.test(session.files['index.html'].content), `${preset.id} preview should be interactive`);
      assert.strictEqual(session.verificationRuns[0].passed, false, `${preset.id} pass 1 must fail`);
      assert.strictEqual(session.verificationRuns[session.verificationRuns.length - 1].passed, true, `${preset.id} healed pass must succeed`);
      assert.strictEqual(session.reworkCycles, 1, `${preset.id} must record exactly 1 rework cycle`);
      assert.deepStrictEqual(
        session.verificationRuns.map((r) => [r.pass, r.phase, r.passed]),
        [[1, 'pass1_initial', false], [2, 'rework_verify', true]],
        `${preset.id}: 1 rework cycle = exactly 1 failing (Pass 1) + 1 passing (Pass 2) verification`
      );
      const diff = session.reworkDiffs.find((entry) => entry.path === 'domain.js');
      assert.ok(diff, `${preset.id} must diff domain.js`);
      const removed = diff.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
      const added = diff.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
      assert.ok(removed.some((line) => line.includes('pass-1 fault')), `${preset.id} diff must remove the broken line`);
      assert.ok(added.length >= 1, `${preset.id} diff must add the healed line`);
      assert.ok(diff.beforeSnippet && diff.afterSnippet);
      assert.ok(session.fileHistory['domain.js'].length >= 3, `${preset.id} fileHistory must keep clean, broken, and healed snapshots`);
      const benchmark = JSON.parse(session.files['benchmark.json'].content);
      assert.ok(benchmark.reworkDiffs.length >= 1, `${preset.id} benchmark.json must include reworkDiffs`);
      assert.ok(benchmark.fileHistory['domain.js'], `${preset.id} benchmark.json must include fileHistory`);
      assert.strictEqual(benchmark.verification.runsCount, 2, `${preset.id} benchmark.json runsCount`);
      assert.strictEqual(benchmark.verification.failedRuns, 1, `${preset.id} benchmark.json failedRuns`);
      assert.strictEqual(benchmark.verification.passedRuns, 1, `${preset.id} benchmark.json passedRuns`);
      assert.deepStrictEqual(benchmark.verification.runs.map((r) => r.phase), ['pass1_initial', 'rework_verify']);
      const serialized = engine.serializeSession(session);
      assert.ok(serialized.reworkDiffs.length >= 1 && serialized.fileHistory['domain.js']);
      console.log(`[PASS] 6.3 ${preset.id}: multi-file workspace, sandbox green, Pass 1 -> Pass 2 diff`);
    } finally {
      fs.rmSync(session.workspaceDir, { recursive: true, force: true });
    }
  }
}

function testReplyParserShapes() {
  console.log('\n--- [Suite 7] Muse Spark reply parsing (realistic @builder patch shapes) ---');
  const known = ['domain.js', 'app.js', 'test.js', 'index.html'];
  const fixed = "function breached(m, s) {\n  return m >= s; // \"minutes\"\n}\nmodule.exports = { breached };";
  const asJson = JSON.stringify(fixed);
  const cases = [
    ['fenced json, files array', '```json\n{"messageToVerifier":"@verifier fixed","files":[{"path":"domain.js","content":' + asJson + '}]}\n```', 'json_files_array'],
    ['<think> block + prose + fence, ./ path', '<think>The SLA compares minutes to ms {not good}.</think>\nRoot cause found. Patch below:\n```json\n{"files":[{"path":"./domain.js","content":' + asJson + '}]}\n```\nLet me know!', 'json_files_array'],
    ['files object map', '{"messageToVerifier":"ok","files":{"domain.js":' + asJson + '}}', 'json_files_object'],
    ['files object map with {content}', '{"files":{"./domain.js":{"content":' + asJson + '}}}', 'json_files_object'],
    ['single path/content pair', 'Sure.\n{"path":"domain.js","content":' + asJson + ',"messageToVerifier":"fixed"}', 'json_single_file'],
    ['raw newlines inside the JSON string', '```json\n{"files":[{"path":"domain.js","content":"' + fixed.replace(/"/g, '\\"') + '"}]}\n```', 'json_files_array'],
    ['template-literal value', '{"files":{"domain.js":`' + fixed + '`}}', 'json_files_object'],
    ['absolute workspace path + trailing comma', '{"files":[{"path":"/tmp/x/workspaces/sprint-priority-engine-ab12/domain.js","content":' + asJson + '},]}', 'json_files_array'],
    ['patch key + file/code keys', '{"patch":[{"file":"domain.js","code":' + asJson + '}]}', 'json_patch_array'],
    ['prose with a labelled ```javascript fence', 'The bug is in **domain.js**:\n```javascript\n' + fixed + '\n```', 'fenced_code'],
    ['fence with a // file: comment', '```js\n// file: domain.js\n' + fixed + '\n```', 'fenced_code'],
  ];
  for (const [label, reply, format] of cases) {
    const out = extractFilePatch(reply, known);
    assert.strictEqual(out.format, format, `${label}: format`);
    assert.deepStrictEqual(Object.keys(out.files), ['domain.js'], `${label}: path`);
    const expected = format === 'fenced_code' && label.includes('file:') ? `// file: domain.js\n${fixed}` : fixed;
    assert.strictEqual(out.files['domain.js'], expected, `${label}: content`);
  }
  const truncated = extractFilePatch('```json\n{"files":[{"path":"domain.js","content":"function breached(m, s) {\\n  return m >=', known);
  assert.deepStrictEqual(truncated.files, {}, 'truncated reply yields no patch');
  const unknownPath = extractFilePatch('{"files":[{"path":"../../etc/passwd","content":"x"},{"path":"other.js","content":"y"}]}', known);
  assert.deepStrictEqual(unknownPath.files, {}, 'paths outside the workspace are ignored');
  assert.strictEqual(extractJsonBlock('<think>{x}</think>\n{"verdict":"VERIFIED_PASS","qualityScore":91}').qualityScore, 91);
  console.log(`[PASS] 7.1: reply parser handles ${cases.length} realistic patch shapes, truncation and unknown paths`);
}

function mockLiveBuilder(engine, makeFix) {
  const base = engine.client;
  const original = base.chatCompletion.bind(base);
  const prompts = [];
  base.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && user.includes('Rework Attempt #')) {
      prompts.push(user);
      const res = {
        id: 'mock-live',
        model: 'meta-models/muse-spark-open-1026',
        simulated: false,
        content: makeFix(user),
        reasoningContent: 'The test fails because the SLA check compares minutes against milliseconds.',
        finishReason: 'stop',
        usage: { promptTokens: 900, completionTokens: 700, totalTokens: 1600, reasoningTokens: 120 },
        latencyMs: 2100,
      };
      if (opts.onProgress) opts.onProgress({ type: 'llm_complete', agentId: 'builder', simulated: false, content: res.content, reasoningContent: res.reasoningContent, finishReason: 'stop', usage: res.usage });
      return res;
    }
    return original(opts);
  };
  return prompts;
}

async function runSprintHeal(makeFix) {
  const engine = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const events = [];
  engine.on('event', (ev) => events.push(ev));
  const prompts = makeFix ? mockLiveBuilder(engine, makeFix) : null;
  const session = engine.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'attribution-test',
    simulateBrokenFirstPass: true,
  });
  try {
    await engine.executeSwarm(session);
    const benchmark = JSON.parse(session.files['benchmark.json'].content);
    return { engine, session, events, prompts, benchmark, serialized: engine.serializeSession(session) };
  } finally {
    fs.rmSync(session.workspaceDir, { recursive: true, force: true });
  }
}

async function testReworkAttribution() {
  const artifacts = buildScenarioArtifacts('sprint-priority-engine');
  const fault = applyPass1Fault(artifacts, 'sprint-priority-engine');
  const phases = (s) => s.verificationRuns.map((r) => [r.phase, r.passed]);
  const sources = (s, file) => s.fileHistory[file].map((h) => `${h.author}:${h.source}`);

  // Offline: no model patch, engine restores, never labelled 'model'.
  const prevKey = process.env.BASETEN_API_KEY;
  const prevMeta = process.env.META_API_KEY;
  process.env.BASETEN_API_KEY = 'sk-live-key-must-not-be-used-0123456789abcdef';
  process.env.META_API_KEY = 'sk-live-key-must-not-be-used-0123456789abcdef';
  let fetches = 0;
  const guarded = new MuseSwarmEngine({
    offline: true,
    allowOfflineFallback: true,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('offline-asserting test must not call the network');
    },
  });
  const guardedEvents = [];
  guarded.on('event', (ev) => guardedEvents.push(ev));
  const guardedSession = guarded.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'offline-key-guard',
    simulateBrokenFirstPass: true,
  });
  try {
    await guarded.executeSwarm(guardedSession);
    assert.strictEqual(fetches, 0, 'offline-asserting tests must not hit Baseten even when a key is in env');
    assert.ok(guarded.client.forceOffline);
    assert.strictEqual(JSON.parse(guardedSession.files['benchmark.json'].content).healedBy[0], 'deterministic_restore');
    assert.ok(guardedEvents.every((e) => e.eventType !== 'llm_complete' || e.simulated === true));
  } finally {
    fs.rmSync(guardedSession.workspaceDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.BASETEN_API_KEY;
    else process.env.BASETEN_API_KEY = prevKey;
    if (prevMeta === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = prevMeta;
  }

  const offline = await runSprintHeal(null);
  assert.deepStrictEqual(phases(offline.session), [['pass1_initial', false], ['rework_verify', true]]);
  assert.deepStrictEqual(sources(offline.session, 'domain.js'), ['engine:scenario_fixture', 'engine:fault_injection', 'engine:deterministic_restore']);
  const offDiff = offline.session.reworkDiffs.find((d) => d.path === 'domain.js');
  assert.strictEqual(offDiff.author, 'engine');
  assert.strictEqual(offDiff.source, 'deterministic_restore');
  assert.strictEqual(offDiff.verifiedPass, true);
  assert.deepStrictEqual(offline.benchmark.healedBy, ['deterministic_restore']);
  assert.strictEqual(offline.benchmark.reworkSummary[0].modelPatch, 'missing');
  assert.deepStrictEqual(offline.serialized.healedBy, ['deterministic_restore']);
  const allSources = Object.values(offline.session.fileHistory).flat().map((h) => h.source);
  assert.ok(!allSources.includes('model'), 'offline writes must never be labelled model');
  const offReply = offline.serialized.modelReplies.find((r) => r.phase === 'rework_fix');
  assert.ok(offReply && offReply.simulated === true && offReply.content.length > 0, 'raw rework reply stored');
  const offWrite = offline.events.find((e) => e.eventType === 'file_written' && e.path === 'domain.js' && e.source === 'deterministic_restore');
  assert.ok(offWrite && offWrite.author === 'engine', 'SSE file_written carries engine attribution');
  assert.ok(offline.events.some((e) => e.eventType === 'llm_complete' && e.agentId === 'builder' && typeof e.content === 'string'), 'SSE llm_complete carries raw content');
  console.log('[PASS] 7.2: offline self-heal is attributed to engine / deterministic_restore everywhere');

  // Live-shaped model patch that changes and fixes domain.js: credited to the model, not overwritten.
  const marker = '// healed by @builder (Muse Spark)';
  const good = await runSprintHeal(() =>
    '<think>minutes vs ms</think>\nRoot cause: SLA unit mismatch.\n```json\n' +
    JSON.stringify({ messageToVerifier: '@verifier SLA now compares minutes to minutes.', files: [{ path: './domain.js', content: `${artifacts['domain.js']}\n${marker}\n` }] }) +
    '\n```'
  );
  assert.ok(good.prompts[0].includes('--- domain.js ---') && good.prompts[0].includes(fault.broken.split('\n').find((l) => l.includes('pass-1 fault')).trim()), 'fix prompt carries the faulty domain.js');
  assert.ok(good.prompts[0].includes('"files": [ { "path":'), 'fix prompt asks for a strict {files:[{path, content}]} patch');
  assert.deepStrictEqual(phases(good.session), [['pass1_initial', false], ['rework_verify', true]]);
  assert.ok(good.session.files['domain.js'].content.includes(marker), 'passing model patch is kept');
  assert.deepStrictEqual(sources(good.session, 'domain.js'), ['engine:scenario_fixture', 'engine:fault_injection', '@builder:model']);
  const goodDiff = good.session.reworkDiffs.find((d) => d.path === 'domain.js');
  assert.strictEqual(goodDiff.source, 'model');
  assert.strictEqual(goodDiff.verifiedPass, true);
  assert.ok(goodDiff.fixedBy.startsWith('@builder'));
  assert.deepStrictEqual(good.benchmark.healedBy, ['model']);
  assert.strictEqual(good.benchmark.reworkSummary[0].modelPatch, 'passed');
  const goodReply = good.serialized.modelReplies.find((r) => r.phase === 'rework_fix');
  assert.ok(goodReply.content.includes(marker) && goodReply.reasoningContent.includes('milliseconds') && goodReply.simulated === false);
  assert.strictEqual(goodReply.parse.format, 'json_files_array');
  console.log('[PASS] 7.3: a model patch that changes and fixes domain.js is credited to model and not overwritten');

  // Model echoes the file unchanged: engine falls back to deterministic_restore.
  const same = await runSprintHeal(() => JSON.stringify({ files: [{ path: 'domain.js', content: fault.broken }] }));
  assert.deepStrictEqual(phases(same.session), [['pass1_initial', false], ['rework_verify', true]]);
  assert.strictEqual(same.benchmark.reworkSummary[0].modelPatch, 'unchanged');
  assert.deepStrictEqual(same.benchmark.healedBy, ['deterministic_restore']);
  assert.strictEqual(same.session.reworkDiffs.find((d) => d.path === 'domain.js').source, 'deterministic_restore');
  console.log('[PASS] 7.4: an unchanged model patch falls back to deterministic_restore');

  // Model changes the file but it still fails: labelled extra run, then engine restore.
  const bad = await runSprintHeal(() => JSON.stringify({ files: [{ path: 'domain.js', content: `${fault.broken}\n// tried\n` }] }));
  assert.deepStrictEqual(phases(bad.session), [['pass1_initial', false], ['rework_verify', false], ['restore_verify', true]]);
  assert.strictEqual(bad.benchmark.reworkSummary[0].modelPatch, 'failed');
  assert.deepStrictEqual(bad.benchmark.healedBy, ['deterministic_restore']);
  const badDiffs = bad.session.reworkDiffs.filter((d) => d.path === 'domain.js').map((d) => [d.source, d.verifiedPass]);
  assert.deepStrictEqual(badDiffs, [['model', false], ['deterministic_restore', true]]);
  console.log('[PASS] 7.5: a failing model patch is labelled, then replaced by deterministic_restore');
}

function runNodeTestJs(dir) {
  const result = spawnSync(process.execPath, ['test.js'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    passed: result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function materializeOnCall(domainJs) {
  const artifacts = buildScenarioArtifacts('oncall-fairness-scheduler');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'museswarm-oncall-'));
  for (const name of ['domain.js', 'app.js', 'test.js']) {
    fs.writeFileSync(path.join(dir, name), name === 'domain.js' ? domainJs : artifacts[name], 'utf8');
  }
  return dir;
}

function testOnCallFairnessDirection() {
  console.log('\n--- [Suite 8] oncall-fairness-scheduler busiest/quietest direction ---');
  const artifacts = buildScenarioArtifacts('oncall-fairness-scheduler');
  const fault = applyPass1Fault(artifacts, 'oncall-fairness-scheduler');
  const inverted = applyOnCallAscendingBusiestFault(artifacts['domain.js']);
  assert.ok(inverted.includes('this.loadOf(a.id) - this.loadOf(b.id)'));
  assert.ok(!inverted.includes('this.engineers.slice().sort((a, b) => this.loadOf(b.id) - this.loadOf(a.id)'));

  const cleanDir = materializeOnCall(artifacts['domain.js']);
  const tzDir = materializeOnCall(fault.broken);
  const ascDir = materializeOnCall(inverted);
  try {
    const clean = runNodeTestJs(cleanDir);
    assert.ok(clean.passed, `clean oncall fixture must pass:\n${clean.stderr}\n${clean.stdout}`);
    assert.ok(clean.stdout.includes('rebalance moves load from the busiest engineer to the quietest'));
    console.log('[PASS] 8.1: clean oncall fixture identifies bao as busiest, chi as quietest, and moves bao -> chi');

    const tz = runNodeTestJs(tzDir);
    assert.ok(!tz.passed, 'injected timezone fault must still fail node test.js');
    console.log('[PASS] 8.2: injected timezone pass-1 fault still fails the oncall tests');

    const asc = runNodeTestJs(ascDir);
    assert.ok(!asc.passed, "ascending sort + ranked[0] as busiest must fail");
    assert.ok(
      /busiest|quietest|bao|chi/.test(`${asc.stdout}\n${asc.stderr}`),
      'ascending variant should fail the busiest/quietest assertions'
    );
    console.log('[PASS] 8.3: ascending sort but busiest = ranked[0] fails (inverted rebalance)');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
    fs.rmSync(tzDir, { recursive: true, force: true });
    fs.rmSync(ascDir, { recursive: true, force: true });
  }
}

async function testLeadRetryBuilderBudgetAndSessionTelemetry() {
  console.log('\n--- [Suite 9] @lead retry, @builder build budget, per-session telemetry ---');
  const engine = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const original = engine.client.chatCompletion.bind(engine.client);
  let leadCalls = 0;
  let builderBuildCalls = 0;
  engine.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'architect') {
      assert.strictEqual(opts.timeoutMs, CONFIG.longRequestTimeoutMs, 'architect long timeout');
    }
    if (opts.agentId === 'builder' && !user.includes('Rework Attempt #')) {
      builderBuildCalls += 1;
      assert.strictEqual(opts.maxTokens, 32000);
      assert.strictEqual(opts.timeoutMs, CONFIG.longRequestTimeoutMs);
      assert.strictEqual(opts.reasoningEffort, 'low');
      assert.ok(/"files":\s*\[/.test(user), 'initial build prompt asks for a files array');
    }
    if (opts.agentId === 'lead') {
      leadCalls += 1;
      assert.strictEqual(opts.maxTokens, 16000);
      assert.strictEqual(opts.timeoutMs, CONFIG.longRequestTimeoutMs);
      assert.strictEqual(opts.reasoningEffort, 'low');
      if (leadCalls === 1) {
        assert.ok(!user.includes('ran out of tokens'));
        return {
          id: 'lead-truncated',
          model: 'meta-models/muse-spark-open-1026',
          simulated: false,
          content: '',
          reasoningContent: 'deliberating on the release note '.repeat(400),
          finishReason: 'length',
          usage: { promptTokens: 800, completionTokens: 12000, totalTokens: 12800, reasoningTokens: 11800 },
          latencyMs: 4000,
        };
      }
      assert.ok(user.includes('ran out of tokens'));
      return {
        id: 'lead-retry',
        model: 'meta-models/muse-spark-open-1026',
        simulated: false,
        content: JSON.stringify({
          readmeMd: '# From @lead\n\nShort structured release note.\n',
          finalBroadcast: '@all Architect, builder, verifier, and lead finished the sprint engine.',
        }),
        reasoningContent: '',
        finishReason: 'stop',
        usage: { promptTokens: 400, completionTokens: 200, totalTokens: 600, reasoningTokens: 20 },
        latencyMs: 900,
      };
    }
    return original(opts);
  };

  const session = engine.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'lead-retry',
  });
  try {
    await engine.executeSwarm(session);
    assert.strictEqual(leadCalls, 2, '@lead should retry once after empty length');
    assert.ok(builderBuildCalls >= 1);
    const release = session.modelReplies.find((r) => r.phase === 'release');
    const retry = session.modelReplies.find((r) => r.phase === 'release_retry');
    assert.ok(release && release.finishReason === 'length' && release.parse.retryReason === 'finish_reason_length_empty_content');
    assert.ok(retry && retry.parse.retryOf === 'release' && retry.content.includes('From @lead'));
    assert.strictEqual(session.files['README.md'].author, '@lead');
    assert.strictEqual(session.files['README.md'].source, 'model');
    assert.ok(session.files['README.md'].content.includes('From @lead'));
    console.log('[PASS] 9.1: @lead retries once on finishReason=length with empty content and records both replies');
    console.log('[PASS] 9.2: @builder initial build uses 32000 tokens, reasoning_effort=low, 120s timeout, compact files array');
  } finally {
    fs.rmSync(session.workspaceDir, { recursive: true, force: true });
  }

  const telEngine = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origRecord = telEngine.client.recordUsage.bind(telEngine.client);
  let latencyWave = 0;
  telEngine.client.recordUsage = (usage, _latencyMs, agentId, isSimulated) => {
    origRecord(usage, latencyWave === 0 ? 9000 : 40, agentId, isSimulated);
  };
  const runOnce = async (name) => {
    const s = telEngine.createSession({
      prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
      projectName: name,
    });
    try {
      await telEngine.executeSwarm(s);
      return JSON.parse(s.files['benchmark.json'].content);
    } finally {
      fs.rmSync(s.workspaceDir, { recursive: true, force: true });
    }
  };
  const first = await runOnce('tel-session-a');
  latencyWave = 1;
  const second = await runOnce('tel-session-b');
  const processTel = telEngine.client.getTelemetry();
  assert.ok(first.telemetry.totalCalls > 0 && second.telemetry.totalCalls > 0);
  assert.strictEqual(first.telemetry.totalCalls, second.telemetry.totalCalls, 'each session should report its own call count');
  assert.strictEqual(first.telemetry.latencies.length, first.telemetry.totalCalls);
  assert.strictEqual(second.telemetry.latencies.length, second.telemetry.totalCalls);
  assert.ok(first.telemetry.latencies.every((ms) => ms === 9000), 'session 1 latencies are only its own 9000ms calls');
  assert.ok(second.telemetry.latencies.every((ms) => ms === 40), 'session 2 latencies must not include session 1');
  assert.strictEqual(first.telemetry.p95LatencyMs, 9000);
  assert.strictEqual(second.telemetry.p95LatencyMs, 40, "session 2's p95 must not leak session 1's 9000ms");
  assert.strictEqual(second.telemetry.maxLatencyMs, 40);
  assert.ok(!second.telemetry.latencies.includes(9000));
  assert.strictEqual(
    processTel.totalCalls,
    first.telemetry.totalCalls + second.telemetry.totalCalls,
    'process-wide totals remain the sum of both sessions'
  );
  assert.notStrictEqual(second.telemetry.totalCalls, processTel.totalCalls);
  console.log('[PASS] 9.3: back-to-back sessions scope call counts, latencies, and p95; process totals stay separate');

  const artifacts = buildScenarioArtifacts('sprint-priority-engine');
  const modelEngine = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const modelOrig = modelEngine.client.chatCompletion.bind(modelEngine.client);
  modelEngine.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && !user.includes('Rework Attempt #')) {
      return {
        id: 'builder-live-files',
        model: 'meta-models/muse-spark-open-1026',
        simulated: false,
        content: JSON.stringify({
          messageToArchitect: '@architect implemented.',
          messageToVerifier: '@verifier please run test.js.',
          files: [
            { path: 'app.js', content: `${artifacts['app.js']}\n// model-built app.js\n` },
            { path: 'index.html', content: artifacts['index.html'] },
            { path: 'test.js', content: artifacts['test.js'] },
          ],
        }),
        reasoningContent: '',
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60, reasoningTokens: 0 },
        latencyMs: 80,
      };
    }
    return modelOrig(opts);
  };
  const modelSession = modelEngine.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'model-build',
    simulateBrokenFirstPass: true,
  });
  try {
    await modelEngine.executeSwarm(modelSession);
    assert.ok(modelSession.files['app.js'].content.includes('model-built app.js'));
    assert.strictEqual(modelSession.files['app.js'].source, 'model');
    assert.strictEqual(modelSession.files['app.js'].author, '@builder');
    assert.strictEqual(modelSession.files['test.js'].source, 'scenario_fixture');
    assert.ok(modelSession.fileHistory['test.js'].some((h) => h.source === 'rejected_protected_file'));
    assert.ok(!modelSession.fileHistory['test.js'].some((h) => h.source === 'model'));
    assert.ok(modelSession.fileHistory['domain.js'].some((h) => h.source === 'scenario_fixture'));
    assert.ok(modelSession.fileHistory['domain.js'].some((h) => h.source === 'fault_injection'));
    assert.ok(modelSession.fileHistory['domain.js'].some((h) => h.source === 'deterministic_restore'));
    assert.deepStrictEqual(JSON.parse(modelSession.files['benchmark.json'].content).healedBy, ['deterministic_restore']);
    assert.ok(modelSession.verificationRuns[modelSession.verificationRuns.length - 1].passed);
    console.log('[PASS] 9.4: a parsed @builder build writes model app.js; test.js stays engine fixture; rework heal still works');
  } finally {
    fs.rmSync(modelSession.workspaceDir, { recursive: true, force: true });
  }

  const truncEngine = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const truncOrig = truncEngine.client.chatCompletion.bind(truncEngine.client);
  let buildCalls = 0;
  truncEngine.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && !user.includes('Rework Attempt #')) {
      buildCalls += 1;
      return {
        id: `builder-trunc-${buildCalls}`,
        simulated: false,
        content: '',
        reasoningContent: 'still thinking about app.js '.repeat(200),
        finishReason: 'length',
        usage: { promptTokens: 10, completionTokens: 16000, totalTokens: 16010, reasoningTokens: 15900 },
        latencyMs: 100,
      };
    }
    return truncOrig(opts);
  };
  const truncSession = truncEngine.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'trunc-build',
  });
  try {
    await truncEngine.executeSwarm(truncSession);
    assert.strictEqual(buildCalls, 2, 'truncated build retries once');
    assert.ok(truncSession.modelReplies.some((r) => r.phase === 'build' && r.parse.retryReason === 'finish_reason_length_no_files'));
    assert.ok(truncSession.modelReplies.some((r) => r.phase === 'build_retry'));
    assert.strictEqual(truncSession.files['app.js'].source, 'scenario_fixture');
    assert.strictEqual(truncSession.files['app.js'].author, 'engine');
    console.log('[PASS] 9.5: truncated @builder build keeps engine:scenario_fixture attribution after retry');
  } finally {
    fs.rmSync(truncSession.workspaceDir, { recursive: true, force: true });
  }

  const reworkEngine = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const reworkOrig = reworkEngine.client.chatCompletion.bind(reworkEngine.client);
  let reworkCalls = 0;
  reworkEngine.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && user.includes('Rework Attempt #')) {
      reworkCalls += 1;
      assert.strictEqual(opts.maxTokens, 32000, 'rework max_tokens must be 32000');
      assert.strictEqual(opts.reasoningEffort, 'low');
      assert.strictEqual(opts.timeoutMs, CONFIG.longRequestTimeoutMs);
      assert.ok(user.includes('--- domain.js ---'));
      assert.ok(user.includes('--- test.js (read-only) ---'));
      assert.ok(!user.includes('const assert = require'));
      if (reworkCalls === 1) {
        assert.ok(!user.includes('ran out of tokens'));
        return {
          id: 'rework-trunc',
          simulated: false,
          content: '',
          reasoningContent: 'still thinking about domain.js '.repeat(200),
          finishReason: 'length',
          usage: { promptTokens: 10, completionTokens: 16000, totalTokens: 16010, reasoningTokens: 15900 },
          latencyMs: 100,
        };
      }
      assert.ok(user.includes('ran out of tokens'));
      return reworkOrig(opts);
    }
    return reworkOrig(opts);
  };
  const reworkSession = reworkEngine.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'rework-budget',
    simulateBrokenFirstPass: true,
  });
  try {
    await reworkEngine.executeSwarm(reworkSession);
    assert.ok(reworkCalls >= 2, 'rework retries once on empty finishReason=length');
    const first = reworkSession.modelReplies.find((r) => r.phase === 'rework_fix');
    const retry = reworkSession.modelReplies.find((r) => r.phase === 'rework_fix_retry');
    assert.ok(first && first.finishReason === 'length' && first.parse.retryReason === 'finish_reason_length_empty_content');
    assert.ok(retry && retry.parse.retryOf === 'rework_fix');
    assert.deepStrictEqual(JSON.parse(reworkSession.files['benchmark.json'].content).healedBy, ['deterministic_restore']);
    console.log('[PASS] 9.6: @builder rework uses 32000 tokens, reasoning_effort=low, compact prompt, retries empty length');
  } finally {
    fs.rmSync(reworkSession.workspaceDir, { recursive: true, force: true });
  }
}

async function testProtectedScenarioTests() {
  console.log('\n--- [Suite 10] Scenario test.js is engine-owned grading ---');
  const artifacts = buildScenarioArtifacts('sprint-priority-engine');
  const weakTest = 'console.log("[PASS] stub");\n';

  const engineA = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origA = engineA.client.chatCompletion.bind(engineA.client);
  engineA.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && !user.includes('Rework Attempt')) {
      return {
        id: 'weak-build-tests',
        simulated: false,
        content: JSON.stringify({
          files: [
            { path: 'app.js', content: artifacts['app.js'] },
            { path: 'index.html', content: artifacts['index.html'] },
            { path: 'test.js', content: weakTest },
          ],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 },
        latencyMs: 20,
      };
    }
    return origA(opts);
  };
  const sessionA = engineA.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'case-a-weak-tests',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineA.executeSwarm(sessionA);
    assert.strictEqual(sessionA.verificationRuns[0].phase, 'pass1_initial');
    assert.strictEqual(sessionA.verificationRuns[0].passed, false, 'case A: fixture tests must fail Pass 1 despite a weak model test.js');
    assert.ok(sessionA.reworkCycles >= 1, 'case A must enter rework');
    assert.strictEqual(sessionA.files['test.js'].content, artifacts['test.js']);
    assert.notStrictEqual(sessionA.files['test.js'].source, 'model');
    assert.ok(sessionA.fileHistory['test.js'].some((h) => h.source === 'rejected_protected_file' && h.content === weakTest));
    assert.ok(!sessionA.fileHistory['test.js'].some((h) => h.source === 'model'));
    assert.ok(sessionA.fileHistory['domain.js'].some((h) => h.source === 'fault_injection'));
    const healedA = (sessionA.reworkSummary || []).map((c) => c.healedBy);
    assert.ok(!healedA.includes('model'), 'case A must not credit a model heal from weak tests');
    if (sessionA.rubricEvaluation?.verdict === 'VERIFIED_PASS') {
      assert.ok(!sessionA.files['domain.js'].content.includes('pass-1 fault'));
      assert.ok(healedA.includes('deterministic_restore'));
    }
    console.log('[PASS] 10.1: case A weak test.js at build cannot skip rework or hide the SLA bug');
  } finally {
    fs.rmSync(sessionA.workspaceDir, { recursive: true, force: true });
  }

  const engineB = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origB = engineB.client.chatCompletion.bind(engineB.client);
  const reworkPrompts = [];
  engineB.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && user.includes('Rework Attempt')) {
      reworkPrompts.push(user);
      return {
        id: 'weak-rework-tests',
        simulated: false,
        content: JSON.stringify({
          messageToVerifier: '@verifier tests now pass',
          files: [{ path: 'test.js', content: weakTest }],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 },
        latencyMs: 20,
      };
    }
    return origB(opts);
  };
  const sessionB = engineB.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'case-b-testjs-only',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineB.executeSwarm(sessionB);
    assert.ok(reworkPrompts.length >= 1);
    assert.ok(reworkPrompts[0].includes('read-only'), 'rework prompt must mark test.js read-only');
    assert.ok(reworkPrompts[0].includes('--- test.js (read-only) ---'));
    assert.ok(!/patch ONLY these writable files:\s*test\.js/.test(reworkPrompts[0]));
    assert.ok(!sessionB.reworkSummary.some((c) => (c.filesPatchedByModel || []).includes('test.js')));
    const healedB = (sessionB.reworkSummary || []).map((c) => c.healedBy);
    assert.ok(!healedB.includes('model'), 'test.js-only patch must not report healedBy model');
    assert.ok(sessionB.fileHistory['test.js'].some((h) => h.source === 'rejected_protected_file' && h.content === weakTest));
    assert.strictEqual(sessionB.files['test.js'].content, artifacts['test.js']);
    assert.notStrictEqual(sessionB.files['test.js'].source, 'model');
    const benchB = JSON.parse(sessionB.files['benchmark.json'].content);
    assert.ok(!(benchB.healedBy || []).includes('model'));
    if (sessionB.rubricEvaluation?.verdict === 'VERIFIED_PASS') {
      assert.ok(!sessionB.files['domain.js'].content.includes('pass-1 fault'), 'verified only after a real domain.js fix');
      assert.ok(healedB.includes('deterministic_restore'));
    }
    console.log('[PASS] 10.2: case B test.js-only rework patch is rejected and cannot heal as model');
  } finally {
    fs.rmSync(sessionB.workspaceDir, { recursive: true, force: true });
  }

  const shimAppJs = `${artifacts['app.js']}
const __assert = require('assert');
['strictEqual', 'ok', 'deepStrictEqual', 'throws', 'equal', 'notStrictEqual'].forEach(function (k) {
  if (typeof __assert[k] === 'function') __assert[k] = function () {};
  if (__assert.strict && typeof __assert.strict[k] === 'function') __assert.strict[k] = function () {};
});
`;
  const engineC = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origC = engineC.client.chatCompletion.bind(engineC.client);
  engineC.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && user.includes('Rework Attempt')) {
      return {
        id: 'shim-assert-appjs',
        simulated: false,
        content: JSON.stringify({
          messageToVerifier: '@verifier tests now pass',
          files: [{ path: 'app.js', content: shimAppJs }],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 },
        latencyMs: 20,
      };
    }
    return origC(opts);
  };
  const sessionC = engineC.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'case-c-assert-shim',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineC.executeSwarm(sessionC);
    const healedC = (sessionC.reworkSummary || []).map((c) => c.healedBy);
    const benchC = JSON.parse(sessionC.files['benchmark.json'].content);
    assert.ok(!healedC.includes('model'), 'path C must not credit healedBy model for an app.js assert shim');
    assert.ok(!(benchC.healedBy || []).includes('model'));
    assert.ok(!sessionC.reworkSummary.some((c) => (c.filesPatchedByModel || []).includes('app.js')));
    assert.ok(
      sessionC.fileHistory['app.js'].some((h) => h.source === 'rejected_non_target' && h.content.includes('__assert')),
      'app.js shim must be recorded as rejected_non_target'
    );
    const replyC = (sessionC.modelReplies || []).find((r) => r.phase === 'rework_fix');
    assert.ok(replyC && (replyC.parse.rejectedNonTargets || []).includes('app.js'));
    assert.strictEqual(replyC.parse.modelPatch, 'rejected_non_target');
    assert.notStrictEqual(sessionC.files['app.js'].source, 'model');
    const faultStillPresent = sessionC.files['domain.js'].content.includes('pass-1 fault');
    if (sessionC.rubricEvaluation?.verdict === 'VERIFIED_PASS') {
      assert.ok(!faultStillPresent, 'must not be VERIFIED_PASS while the SLA fault remains');
      assert.ok(healedC.includes('deterministic_restore'));
    } else {
      assert.ok(faultStillPresent || healedC.includes('deterministic_restore'));
    }
    console.log('[PASS] 10.3: path C app.js assert shim cannot yield healedBy model or a verified pass with the SLA fault');
  } finally {
    fs.rmSync(sessionC.workspaceDir, { recursive: true, force: true });
  }

  // Leftover build-time app.js shim + a non-fixing domain.js "patch" would pass workspace
  // tests; the independent grade (fixture app.js + model domain.js) must reject it.
  const fault = applyPass1Fault(artifacts, 'sprint-priority-engine');
  const fakeDomain = `${fault.broken}\n// pretend fix, SLA still broken\n`;
  const engineD = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origD = engineD.client.chatCompletion.bind(engineD.client);
  engineD.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && !user.includes('Rework Attempt')) {
      return {
        id: 'shim-assert-build',
        simulated: false,
        content: JSON.stringify({
          files: [
            { path: 'app.js', content: shimAppJs },
            { path: 'index.html', content: artifacts['index.html'] },
          ],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 },
        latencyMs: 20,
      };
    }
    if (opts.agentId === 'builder' && user.includes('Rework Attempt')) {
      return {
        id: 'fake-domain-patch',
        simulated: false,
        content: JSON.stringify({
          messageToVerifier: '@verifier domain.js patched',
          files: [{ path: 'domain.js', content: fakeDomain }],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 },
        latencyMs: 20,
      };
    }
    return origD(opts);
  };
  const sessionD = engineD.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'case-c-grade-check',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineD.executeSwarm(sessionD);
    const pass1 = sessionD.verificationRuns.find((r) => r.phase === 'pass1_initial');
    assert.strictEqual(pass1.passed, false, 'Pass 1 must fail when the SLA fault is in domain.js');
    assert.ok(
      sessionD.fileHistory['app.js'].some((h) => h.source === 'rejected_contract' && h.content.includes('__assert')),
      'build-time app.js assert shim must be rejected_contract'
    );
    assert.ok(sessionD.files['app.js'].content.includes("require('./domain.js')"));
    assert.notStrictEqual(sessionD.files['app.js'].source, 'model');
    const healedD = (sessionD.reworkSummary || []).map((c) => c.healedBy);
    assert.ok(!healedD.includes('model'), 'unfixed domain.js must not be credited to model even if workspace tests pass');
    assert.ok(!(JSON.parse(sessionD.files['benchmark.json'].content).healedBy || []).includes('model'));
    assert.ok(!sessionD.files['domain.js'].content.includes('pass-1 fault'));
    assert.ok(healedD.includes('deterministic_restore'));
    console.log('[PASS] 10.3b: leftover app.js shim + unfixed domain.js is not healedBy model');
  } finally {
    fs.rmSync(sessionD.workspaceDir, { recursive: true, force: true });
  }

  // Path D (Judy probe): domain.js that disables assert then keeps the SLA fault.
  const engineE = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origE = engineE.client.chatCompletion.bind(engineE.client);
  let sessionE;
  engineE.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && user.includes('Rework Attempt #')) {
      const faulty = sessionE.files['domain.js'].content;
      return {
        id: 'judy-probe-domain-shim',
        simulated: false,
        content: JSON.stringify({
          files: [{ path: 'domain.js', content: "{const a=require('assert');for(const k of Object.keys(a))a[k]=()=>{};}\n" + faulty }],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 0 },
        latencyMs: 5,
      };
    }
    return origE(opts);
  };
  sessionE = engineE.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'judy-probe-domain-shim',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineE.executeSwarm(sessionE);
    const healedE = (sessionE.reworkSummary || []).map((c) => c.healedBy);
    const benchE = JSON.parse(sessionE.files['benchmark.json'].content);
    assert.ok(!healedE.includes('model'), 'path D must not credit healedBy model');
    assert.ok(!(benchE.healedBy || []).includes('model'));
    assert.ok(
      sessionE.fileHistory['domain.js'].some((h) => h.source === 'rejected_grading_check' && h.content.includes("require('assert')")),
      'domain.js assert shim must be rejected_grading_check'
    );
    assert.ok(!sessionE.files['domain.js'].content.includes('pass-1 fault'), 'fault must be gone via deterministic_restore');
    assert.ok(healedE.includes('deterministic_restore'));
    assert.ok(!sessionE.files['domain.js'].content.includes("require('assert')"));
    console.log('[PASS] 10.4: path D domain.js assert shim is not credited to model; fault gone via deterministic_restore');
  } finally {
    fs.rmSync(sessionE.workspaceDir, { recursive: true, force: true });
  }

  const noDomainApp = 'module.exports = { TaskPriorityEngine: class { addItem() { return { slaBreached: true }; } } }; globalThis.AppCore = module.exports;\n';
  const engineF = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origF = engineF.client.chatCompletion.bind(engineF.client);
  engineF.client.chatCompletion = async (opts) => {
    const user = opts.messages[opts.messages.length - 1].content;
    if (opts.agentId === 'builder' && !user.includes('Rework Attempt')) {
      return {
        id: 'no-domain-require',
        simulated: false,
        content: JSON.stringify({
          files: [
            { path: 'app.js', content: noDomainApp },
            { path: 'index.html', content: artifacts['index.html'] },
          ],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, reasoningTokens: 0 },
        latencyMs: 20,
      };
    }
    return origF(opts);
  };
  const sessionF = engineF.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'no-domain-app',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineF.executeSwarm(sessionF);
    assert.ok(
      sessionF.fileHistory['app.js'].some((h) => h.source === 'rejected_contract' && h.content.includes('TaskPriorityEngine')),
      'build app.js that never requires ./domain.js must be rejected'
    );
    assert.ok(sessionF.files['app.js'].content.includes("require('./domain.js')"), 'fixture app.js must replace the rejected build');
    assert.notStrictEqual(sessionF.files['app.js'].source, 'model');
    assert.ok(!sessionF.files['domain.js'].content.includes('pass-1 fault'));
    assert.strictEqual(sessionF.files['test.js'].content, artifacts['test.js']);
    assert.ok(sessionF.files['index.html'].content.length > 0);
    console.log('[PASS] 10.5: build app.js without require(./domain.js) is rejected and overridden by the fixture');
    console.log('[PASS] 10.7: restore/fallback puts scenario fixtures back (app.js, test.js, domain.js)');
  } finally {
    fs.rmSync(sessionF.workspaceDir, { recursive: true, force: true });
  }

  const engineG = new MuseSwarmEngine({ offline: true, allowOfflineFallback: true });
  const origTests = engineG.runWorkspaceTests.bind(engineG);
  engineG.runWorkspaceTests = function (session, label) {
    const run = origTests(session, label);
    run.passed = false;
    run.checks.push({ name: 'forced_fail', passed: false, detail: 'all verification runs forced to fail' });
    run.failedCount = (run.failedCount || 0) + 1;
    run.passedCount = run.checks.filter((c) => c.passed).length;
    return run;
  };
  const sessionG = engineG.createSession({
    prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
    scenarioId: 'sprint-priority-engine',
    projectName: 'all-fail-verdict',
    simulateBrokenFirstPass: true,
  });
  try {
    await engineG.executeSwarm(sessionG);
    assert.ok((sessionG.verificationRuns || []).length >= 1);
    assert.ok(sessionG.verificationRuns.every((r) => r.passed === false), 'every verification run failed');
    assert.notStrictEqual(sessionG.rubricEvaluation.verdict, 'VERIFIED_PASS');
    assert.strictEqual(sessionG.rubricEvaluation.verdict, 'VERIFIED_FAIL');
    assert.strictEqual(sessionG.rubricEvaluation.rubric.correctness, 0);
    assert.strictEqual(sessionG.rubricEvaluation.rubric.testCoverage, 0);
    assert.strictEqual(
      sessionG.rubricEvaluation.qualityScore,
      sessionG.rubricEvaluation.rubric.architectureAdherence + sessionG.rubricEvaluation.rubric.uiCompleteness
    );
    assert.ok(sessionG.rubricEvaluation.qualityScore <= 50, 'VERIFIED_FAIL must not show a passing-looking score');
    const benchG = JSON.parse(sessionG.files['benchmark.json'].content);
    assert.notStrictEqual(benchG.rubric?.verdict, 'VERIFIED_PASS');
    assert.ok(benchG.rubric?.qualityScore <= 50);
    console.log('[PASS] 10.6: all-failed verification runs never yield VERIFIED_PASS');
  } finally {
    fs.rmSync(sessionG.workspaceDir, { recursive: true, force: true });
  }
}

async function waitForUrl(url, timeoutMs = 20000) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw lastErr || new Error(`timed out waiting for ${url}`);
}

async function readSseEvents(url, { until, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const chunk of chunks) {
        const line = chunk.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        events.push(event);
        if (until && until(event, events)) {
          try { await reader.cancel(); } catch (_) {}
          return events;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

async function testPublicDemoMode() {
  console.log('\n--- [Suite 11] Public demo replay (goldens, no live Baseten, SSE, rate limit) ---');

  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
  assert.strictEqual(limiter.allow('a'), true);
  assert.strictEqual(limiter.allow('a'), true);
  assert.strictEqual(limiter.allow('a'), false);
  assert.strictEqual(limiter.allow('b'), true);
  const gate = createConcurrencyGate(1);
  assert.strictEqual(gate.tryEnter(), true);
  assert.strictEqual(gate.tryEnter(), false);
  gate.leave();
  assert.strictEqual(gate.tryEnter(), true);
  gate.leave();
  console.log('[PASS] 11.1: rate limiter and concurrency gate helpers');

  const goldens = Array.from(httpEngine.sessions.values()).filter(isGoldenSession);
  assert.strictEqual(goldens.length, 3, 'in-process server must load the 3 golden workspaces');
  const catalog = goldenCatalog(httpEngine);
  const byScenario = Object.fromEntries(catalog.map((g) => [g.scenarioId, g]));
  assert.deepStrictEqual(byScenario['sprint-priority-engine'].healedBy, ['model']);
  assert.deepStrictEqual(byScenario['feature-flag-rollout'].healedBy, ['model']);
  assert.deepStrictEqual(byScenario['oncall-fairness-scheduler'].healedBy, ['deterministic_restore']);
  const replay = buildReplayEvents(goldens.find((s) => s.id === 'swarm-mvti4gn7-bvy7'));
  assert.ok(replay.some((e) => e.eventType === 'session_created'));
  assert.ok(replay.some((e) => e.eventType === 'llm_complete'));
  assert.ok(replay.some((e) => e.eventType === 'file_written'));
  assert.ok(replay.some((e) => e.eventType === 'session_completed' && Array.isArray(e.healedBy)));
  console.log('[PASS] 11.2: three goldens load with honest healedBy and SSE replay events');

  const prevDemo = process.env.MUSE_SWARM_PUBLIC_DEMO;
  process.env.MUSE_SWARM_PUBLIC_DEMO = '1';
  const demoClient = new BasetenMuseClient();
  assert.ok(demoClient.forceOffline, 'PUBLIC_DEMO=1 must forceOffline even without MUSE_SWARM_OFFLINE');
  assert.strictEqual(demoClient.apiKey, '');
  const tel = demoClient.getTelemetry();
  assert.strictEqual(tel.mode, 'public-demo');
  assert.strictEqual(tel.hasApiKey, false);
  const sim = await demoClient.chatCompletion({
    agentId: 'lead',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.strictEqual(sim.simulated, true);
  if (prevDemo === undefined) delete process.env.MUSE_SWARM_PUBLIC_DEMO;
  else process.env.MUSE_SWARM_PUBLIC_DEMO = prevDemo;
  console.log('[PASS] 11.3: Baseten client in public-demo never uses a live key');

  const port = 18767;
  const baseUrl = `http://127.0.0.1:${port}`;
  const childEnv = {
    ...process.env,
    PORT: String(port),
    MUSE_SWARM_PUBLIC_DEMO: '1',
    MUSE_SWARM_OFFLINE: '0',
    BASETEN_API_KEY: 'sk-live-must-not-be-used-0123456789abcdef',
    META_API_KEY: 'sk-live-must-not-be-used-0123456789abcdef',
    MUSE_SWARM_SSE_REPLAY_MS: '0',
    MUSE_SWARM_PUBLIC_DEMO_POST_LIMIT: '2',
    MUSE_SWARM_PUBLIC_DEMO_POST_WINDOW_MS: '60000',
    MUSE_SWARM_PUBLIC_DEMO_MAX_CONCURRENT: '2',
  };
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (chunk) => { childOut += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOut += chunk.toString(); });
  const createdDirs = [];
  try {
    let healthRes;
    try {
      healthRes = await waitForUrl(`${baseUrl}/api/health`);
    } catch (err) {
      err.message += `\n--- demo server output ---\n${childOut}`;
      throw err;
    }
    const health = await healthRes.json();
    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual(health.mode, 'public-demo');
    assert.strictEqual(health.telemetry.mode, 'public-demo');
    assert.strictEqual(health.telemetry.hasApiKey, false);
    assert.strictEqual(health.goldens.length, 3);
    console.log('[PASS] 11.4: spawned public-demo server reports mode public-demo with a key set');

    const statusRes = await fetch(`${baseUrl}/api/status`);
    const status = await statusRes.json();
    assert.strictEqual(status.mode, 'public-demo');
    const statusById = Object.fromEntries(status.goldens.map((g) => [g.scenarioId, g]));
    assert.deepStrictEqual(statusById['sprint-priority-engine'].healedBy, ['model']);
    assert.deepStrictEqual(statusById['feature-flag-rollout'].healedBy, ['model']);
    assert.deepStrictEqual(statusById['oncall-fairness-scheduler'].healedBy, ['deterministic_restore']);
    const sprint = status.sessions.find((s) => s.id === 'swarm-mvti4gn7-bvy7');
    assert.ok(sprint && sprint.golden && sprint.readOnly);
    const preview = await fetch(`${baseUrl}/preview/swarm-mvti4gn7-bvy7/index.html`);
    assert.strictEqual(preview.status, 200);
    const diffs = await fetch(`${baseUrl}/api/session/swarm-mvti4gn7-bvy7/diffs`);
    const diffsJson = await diffs.json();
    assert.ok(diffsJson.reworkDiffs.length >= 1);
    console.log('[PASS] 11.5: goldens served via status, preview, and diffs with correct healedBy');

    const sseEvents = await readSseEvents(`${baseUrl}/api/events?sessionId=swarm-mvti4gn7-bvy7`, {
      until: (ev) => ev.eventType === 'session_completed',
    });
    assert.ok(sseEvents[0].eventType === 'connected');
    assert.ok(sseEvents.some((e) => e.eventType === 'llm_complete'));
    assert.ok(sseEvents.some((e) => e.eventType === 'file_written' && e.path === 'domain.js'));
    const done = sseEvents.find((e) => e.eventType === 'session_completed');
    assert.ok(done);
    assert.deepStrictEqual(done.healedBy, ['model']);
    console.log('[PASS] 11.6: SSE replay of a golden session emits recorded events');

    const runRes = await fetch(`${baseUrl}/api/swarm/rework`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarioId: 'sprint-priority-engine',
        projectName: 'demo-offline-rework',
        sync: true,
      }),
    });
    assert.strictEqual(runRes.status, 200);
    const runJson = await runRes.json();
    assert.strictEqual(runJson.ok, true);
    if (runJson.session?.workspaceDir) createdDirs.push(runJson.session.workspaceDir);
    assert.ok(runJson.session.healedBy.includes('deterministic_restore') || runJson.session.healedBy.includes('offline_fixture'));
    const sources = Object.values(runJson.session.fileHistory || {}).flat().map((h) => h.source);
    assert.ok(!sources.includes('model'), 'public-demo POSTs must not label writes as model');
    const afterTel = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.strictEqual(afterTel.telemetry.mode, 'public-demo');
    assert.strictEqual(afterTel.telemetry.hasApiKey, false);
    assert.ok((afterTel.telemetry.liveCalls || 0) === 0, 'public-demo must not record live Baseten calls');
    console.log('[PASS] 11.7: POST rework in public-demo stays offline with honest attribution');

    const second = await fetch(`${baseUrl}/api/swarm/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: '@architect', message: 'rate-limit probe 2' }),
    });
    assert.strictEqual(second.status, 200, 'second POST is still within limit=2');
    const third = await fetch(`${baseUrl}/api/swarm/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: '@architect', message: 'rate-limit probe 3' }),
    });
    assert.strictEqual(third.status, 429, 'third POST in the window must 429');
    const thirdJson = await third.json();
    assert.strictEqual(thirdJson.ok, false);
    console.log('[PASS] 11.8: public-demo POST rate limit returns 429');
  } finally {
    for (const dir of createdDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    if (child.exitCode == null && child.signalCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
          resolve();
        }, 3000);
        child.on('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (!childOut.includes('public-demo') && child.exitCode && child.exitCode !== 0) {
      console.error(childOut);
    }
  }
}

async function main() {
  console.log('=== MuseSwarm Engineering Test & Verification Suite ===');
  await testBasetenClientTelemetryAndRetry();
  await testMessageBusAndKanbanDependencies();
  await testSelfHealingReworkLoop();
  await testServerEndpoints();
  await runFullSwarmE2E();
  await testScenarioPresetsAndPassDiffs();
  testReplyParserShapes();
  await testReworkAttribution();
  testOnCallFairnessDirection();
  await testLeadRetryBuilderBudgetAndSessionTelemetry();
  await testProtectedScenarioTests();
  await testPublicDemoMode();
  console.log('\n✔ ALL UNIT, API & E2E ASSERTIONS PASSED!');
}

main().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
