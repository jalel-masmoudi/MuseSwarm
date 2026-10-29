const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BasetenMuseClient, computePercentile } = require('./baseten-client');
const { MuseSwarmEngine, AGENT_PROFILES, extractJsonBlock, SCENARIO_PRESETS, buildReworkDiff } = require('./swarm-engine');
const { TOOLS } = require('./mcp-server');
const { server, engine: httpEngine, normalizeAgentId } = require('./server');

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
  console.log('[PASS] 3.1: @verifier detected failing assertion, routed stack trace to @builder, and verified fix');

  const appDiff = session.reworkDiffs.find((entry) => entry.path === 'app.js');
  assert.ok(appDiff, 'Real rework must record an app.js unified diff');
  const removed = appDiff.diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  const added = appDiff.diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
  assert.ok(removed.some((line) => line.includes('a - b')), 'Diff must remove the broken pass-1 line');
  assert.ok(added.some((line) => line.includes('a + b')), 'Diff must add the self-healed line');
  assert.ok(appDiff.beforeSnippet && appDiff.afterSnippet, 'Diff must include before/after snippets');
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
    const statusToolRes = await fetch(`${baseUrl}/api/mcp/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'muse_swarm_status', arguments: {} }),
    });
    const statusToolJson = await statusToolRes.json();
    assert.strictEqual(statusToolJson.ok, true, 'Studio muse_swarm_status alias must resolve');
    const statusBody = JSON.parse(statusToolJson.response.result.content[0].text);
    assert.strictEqual(statusBody.model, 'meta-models/muse-spark-open-1026');
    assert.ok(statusBody.activeSession && statusBody.activeSession.reworkCycles >= 1);
    assert.ok(diffJson.reworkDiffs[0].pass1 && diffJson.reworkDiffs[0].pass2, 'Diffs must carry full Pass 1 / Pass 2 text');
    console.log('[PASS] 4.6: POST /api/mcp/invoke returns the MCP JSON-RPC result and latency (incl. Studio muse_swarm_status)');

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
      assert.ok(session.reworkCycles >= 1, `${preset.id} must record a rework cycle`);
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
      const serialized = engine.serializeSession(session);
      assert.ok(serialized.reworkDiffs.length >= 1 && serialized.fileHistory['domain.js']);
      console.log(`[PASS] 6.3 ${preset.id}: multi-file workspace, sandbox green, Pass 1 -> Pass 2 diff`);
    } finally {
      fs.rmSync(session.workspaceDir, { recursive: true, force: true });
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
  console.log('\n✔ ALL UNIT, API & E2E ASSERTIONS PASSED!');
}

main().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
