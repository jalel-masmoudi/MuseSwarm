const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { CONFIG } = require('./config');
const { BasetenMuseClient } = require('./baseten-client');
const {
  SCENARIO_PRESETS,
  resolveScenarioId,
  buildScenarioArtifacts,
  applyPass1Fault,
  serializeScenarios,
} = require('./scenarios');
const { extractJson, extractFilePatch } = require('./reply-parser');
const { scanModelFaultSource } = require('./isolated-grade');
const { AGENT_PROFILES, loadSoul } = require('./roles');
const { buildReworkDiff } = require('./rework-diff');
const { injectGenericPass1Fault } = require('./fallback-artifacts');
const {
  workspaceMethods,
  sessionProtectedFiles,
  isProtectedScenarioFile,
  scenarioFaultFiles,
  isScenarioReworkNonTarget,
  scenarioAllowedLocals,
  isHostileScenarioAppJs,
  reworkTargetFiles,
} = require('./workspace');
const {
  architectPrompt,
  architectFallbackPlan,
  builderPrompt,
  reworkFixPrompt,
  verifierAuditPrompt,
  leadReleasePrompt,
  leadFallbackPlan,
} = require('./prompts');

function extractJsonBlock(text, prefer = null) {
  return extractJson(text, prefer);
}

// Who produced the bytes of a write. Only a non-simulated Baseten reply counts as 'model'.
function replySource(res) {
  return res && res.simulated === false ? 'model' : 'offline_fixture';
}

function isEmptyLengthReply(res) {
  return Boolean(res) && res.finishReason === 'length' && !String(res.content || '').trim();
}

function recordModelReply(session, { agent, phase, res, parse, reworkAttempt = 0 }) {
  if (!session.modelReplies) session.modelReplies = [];
  const entry = {
    agent,
    phase,
    reworkAttempt,
    simulated: res?.simulated !== false,
    model: res?.model || null,
    finishReason: res?.finishReason || null,
    truncated: res?.finishReason === 'length',
    content: String(res?.content || ''),
    reasoningContent: String(res?.reasoningContent || ''),
    usage: res?.usage || null,
    latencyMs: res?.latencyMs || 0,
    parse: parse || null,
    recordedAt: new Date().toISOString(),
  };
  session.modelReplies.push(entry);
  return entry;
}

class MuseSwarmEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.client = options.client || new BasetenMuseClient(options);
    this.maxReworkLoops = options.maxReworkLoops !== undefined ? options.maxReworkLoops : (CONFIG.maxReworkLoops || 2);
    this.enableParallelFanout = options.enableParallelFanout !== undefined ? options.enableParallelFanout : false;
    this.sessions = new Map();
    this.activeSessionId = null;
  }

  createSession({ prompt, projectName = null, parallelFanout = undefined, simulateBrokenFirstPass = false, scenarioId = null }) {
    const id = `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const resolvedScenarioId = resolveScenarioId(scenarioId, prompt);
    const slug = (projectName || resolvedScenarioId || prompt.slice(0, 32))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'app';
    const workspaceDir = path.join(CONFIG.workspacesDir, `${slug}-${id.slice(-4)}`);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const session = {
      id,
      slug,
      prompt,
      workspaceDir,
      scenarioId: resolvedScenarioId,
      parallelFanout: parallelFanout !== undefined ? parallelFanout : this.enableParallelFanout,
      simulateBrokenFirstPass: Boolean(simulateBrokenFirstPass),
      status: 'initialized',
      createdAt: new Date().toISOString(),
      completedAt: null,
      agents: AGENT_PROFILES,
      messages: [], // Bot-to-bot session message bus
      kanban: [],   // Auditable Kanban tasks + comments + history
      files: {},    // Relative path -> file metadata/content preview
      fileHistory: {}, // Relative path -> revision snapshots
      reworkDiffs: [], // Pass 1 -> Pass 2 unified diffs from the self-heal loop
      verificationRuns: [],
      parallelTasksRun: [],
      reworkCycles: 0,
      rubricEvaluation: null,
      benchmark: null,
      ObserverAdvisories: [
        {
          id: 'obs-1',
          observer: 'goal-tracking',
          text: 'Hold swarm to verified runnable code + passing node test.js before closing session.',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'obs-2',
          observer: 'verification',
          text: 'Every generated artifact must be syntax-checked and executed in the workspace sandbox.',
          timestamp: new Date().toISOString(),
        },
      ],
      telemetry: null,
    };

    session._telSnap = this.client.snapshotUsage();
    session.telemetry = this.client.telemetrySince(session._telSnap);

    this.sessions.set(id, session);
    this.activeSessionId = id;
    this.emitEvent(session, 'session_created', { session: this.serializeSession(session) });
    return session;
  }

  emitEvent(session, eventType, payload) {
    session.telemetry = session._telSnap
      ? this.client.telemetrySince(session._telSnap)
      : this.client.getTelemetry();
    const event = {
      eventType,
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    this.emit('event', event);
  }

  postBotMessage(session, { from, to, delivery = 'steer', content, reasoning = '', metadata = {} }) {
    const normalizedFrom = from.startsWith('@') ? from : `@${from}`;
    const normalizedTo = to.startsWith('@') ? to : `@${to}`;
    const validDeliveries = ['steer', 'queue', 'notify'];
    const cleanDelivery = validDeliveries.includes(delivery) ? delivery : 'steer';

    const msg = {
      id: `msg-${session.messages.length + 1}-${Date.now().toString(36)}`,
      from: normalizedFrom,
      to: normalizedTo, // e.g. '@builder', '@verifier', '@architect', '@lead', '@all'
      delivery: cleanDelivery, // 'steer' | 'queue' | 'notify'
      content: String(content || ''),
      reasoning: reasoning ? String(reasoning).slice(0, 1200) : '',
      metadata: metadata || {},
      timestamp: new Date().toISOString(),
    };
    session.messages.push(msg);
    this.emitEvent(session, 'bot_message', { message: msg });
    return msg;
  }

  getMessagesForAgent(session, agentHandle, deliveryFilter = null) {
    const target = agentHandle.startsWith('@') ? agentHandle : `@${agentHandle}`;
    return session.messages.filter((m) => {
      const matchesRecipient = m.to === target || m.to === '@all';
      const matchesDelivery = !deliveryFilter || m.delivery === deliveryFilter;
      return matchesRecipient && matchesDelivery;
    });
  }

  createKanbanTask(session, { id, title, assignee, parentId = null, dependsOn = [], description = '', acceptanceCriteria = [] }) {
    const taskId = id || `TASK-${session.kanban.length + 1}`;
    const existing = session.kanban.find((t) => t.id === taskId);
    if (existing) return existing;

    const deps = Array.isArray(dependsOn) ? [...dependsOn] : [];
    if (parentId && !deps.includes(parentId)) {
      deps.push(parentId);
    }

    const now = new Date().toISOString();
    const task = {
      id: taskId,
      title,
      assignee: assignee && assignee.startsWith('@') ? assignee : `@${assignee || 'builder'}`,
      parentId,
      dependsOn: deps,
      status: 'ready', // 'ready' | 'in_progress' | 'needs_input' | 'rework' | 'done'
      description,
      acceptanceCriteria,
      comments: [],
      history: [{ from: null, to: 'ready', author: '@architect', timestamp: now }],
      createdAt: now,
      updatedAt: now,
    };
    session.kanban.push(task);
    this.emitEvent(session, 'kanban_created', { task });
    return task;
  }

  updateKanbanTask(session, taskId, { status, comment = null, author = 'system' }) {
    const task = session.kanban.find((t) => t.id === taskId);
    if (!task) return null;
    const now = new Date().toISOString();
    if (status && status !== task.status) {
      task.history = task.history || [];
      task.history.push({
        from: task.status,
        to: status,
        author,
        timestamp: now,
      });
      task.status = status;
    }
    task.updatedAt = now;
    if (comment) {
      task.comments.push({
        id: `c-${task.comments.length + 1}`,
        author,
        text: comment,
        timestamp: now,
      });
    }
    this.emitEvent(session, 'kanban_updated', { task });
    return task;
  }

  getReadyTasks(session, assignee = null) {
    const doneIds = new Set(session.kanban.filter((t) => t.status === 'done').map((t) => t.id));
    return session.kanban.filter((t) => {
      if (t.status !== 'ready') return false;
      if (assignee && t.assignee !== assignee) return false;
      const deps = t.dependsOn || (t.parentId ? [t.parentId] : []);
      return deps.every((depId) => doneIds.has(depId));
    });
  }

  async runParallelTasks(session, taskSpecs, workerFn) {
    if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) return [];
    const startMs = Date.now();
    this.emitEvent(session, 'parallel_fanout_start', {
      count: taskSpecs.length,
      taskIds: taskSpecs.map((t) => t.id || t.name || 'subtask'),
    });

    const settled = await Promise.allSettled(
      taskSpecs.map(async (spec, idx) => {
        const subStart = Date.now();
        const res = await workerFn(spec, idx);
        const durationMs = Date.now() - subStart;
        return {
          id: spec.id || `subtask-${idx + 1}`,
          title: spec.title || spec.id || `Subtask ${idx + 1}`,
          durationMs,
          result: res,
        };
      })
    );

    const summary = settled.map((item, idx) => {
      if (item.status === 'fulfilled') {
        return {
          id: item.value.id,
          title: item.value.title,
          status: 'fulfilled',
          durationMs: item.value.durationMs,
          result: item.value.result,
        };
      }
      return {
        id: taskSpecs[idx]?.id || `subtask-${idx + 1}`,
        title: taskSpecs[idx]?.title || `Subtask ${idx + 1}`,
        status: 'rejected',
        error: item.reason?.message || String(item.reason),
      };
    });

    const fanoutRecord = {
      executedAt: new Date().toISOString(),
      concurrency: taskSpecs.length,
      wallTimeMs: Date.now() - startMs,
      tasks: summary.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        durationMs: s.durationMs || 0,
        error: s.error || null,
      })),
    };
    session.parallelTasksRun.push(fanoutRecord);
    this.emitEvent(session, 'parallel_fanout_complete', fanoutRecord);
    return summary;
  }

  evaluateDeterministicRubric(session, testRun) {
    const appCode = session.files['app.js']?.content || '';
    const testCode = session._cleanArtifacts?.['test.js'] || session.files['test.js']?.content || '';
    const htmlCode = session.files['index.html']?.content || '';

    // 1. Correctness & Sandbox Execution (0-25)
    let correctness = testRun.passed ? 25 : Math.max(5, testRun.passedCount * 6);

    // 2. Test Coverage & Assertions (0-25)
    const assertCount = (testCode.match(/assert\./g) || []).length;
    const passCount = (testRun.stdout.match(/\[PASS\]/gi) || []).length;
    let testCoverage = testRun.passed ? Math.min(25, 15 + Math.max(assertCount, passCount) * 2) : 8;

    // 3. Architecture & Isomorphic Contract Adherence (0-25)
    const hasCommonJs = /module\.exports/.test(appCode);
    const hasGlobalExport = /globalThis\.|window\./.test(appCode);
    const zeroExternalDeps = !/require\(['"](?!assert|fs|path|crypto|util|events|http|url)[^.'"]/.test(appCode);
    let architectureAdherence =
      (hasCommonJs ? 10 : 0) +
      (hasGlobalExport ? 8 : 0) +
      (zeroExternalDeps ? 7 : 0);

    // 4. UI Completeness & Documentation (0-25)
    const hasScriptTag = /<script[^>]*src=['"]app\.js['"]/i.test(htmlCode) || /AppCore/.test(htmlCode);
    const hasInteractiveControls = /<button|<input|<select|onclick|addEventListener/i.test(htmlCode);
    let uiCompleteness =
      (htmlCode.length > 300 ? 10 : 0) +
      (hasScriptTag ? 8 : 0) +
      (hasInteractiveControls ? 7 : 0);

    const totalScore = correctness + testCoverage + architectureAdherence + uiCompleteness;
    return {
      totalScore,
      breakdown: {
        correctness,
        testCoverage,
        architectureAdherence,
        uiCompleteness,
      },
      invariants: {
        hasCommonJs,
        hasGlobalExport,
        zeroExternalDeps,
        hasScriptTag,
        hasInteractiveControls,
        assertCount,
      },
    };
  }

  generateBenchmarkSummary(session) {
    if (session._telSnap) session.telemetry = this.client.telemetrySince(session._telSnap);
    const tel = session.telemetry || this.client.getTelemetry();
    const createdMs = new Date(session.createdAt).getTime();
    const completedMs = session.completedAt ? new Date(session.completedAt).getTime() : Date.now();
    const durationMs = Math.max(1, completedMs - createdMs);
    const verRuns = session.verificationRuns || []; const lastVerification = verRuns[verRuns.length - 1] || null;

    const benchmark = {
      sessionId: session.id,
      slug: session.slug,
      prompt: session.prompt,
      modelId: tel.modelId,
      endpoint: tel.endpoint,
      mode: tel.mode,
      status: session.status,
      durationMs,
      scenarioId: session.scenarioId || null,
      reworkCycles: session.reworkCycles || 0,
      healedBy: (session.reworkSummary || []).map((c) => c.healedBy),
      reworkSummary: session.reworkSummary || [],
      fileAttribution: Object.fromEntries(
        Object.values(session.files).map((f) => [f.path, { author: f.author, source: f.source || 'unspecified' }])
      ),
      modelReplies: (session.modelReplies || []).map((r) => ({
        agent: r.agent,
        phase: r.phase,
        reworkAttempt: r.reworkAttempt,
        simulated: r.simulated,
        finishReason: r.finishReason,
        truncated: r.truncated,
        contentChars: r.content.length,
        parse: r.parse,
      })),
      reworkDiffs: session.reworkDiffs || [],
      fileHistory: session.fileHistory || {},
      parallelFanouts: (session.parallelTasksRun || []).length,
      messagesExchanged: (session.messages || []).length,
      kanbanTasksTotal: (session.kanban || []).length,
      kanbanTasksDone: (session.kanban || []).filter((t) => t.status === 'done').length,
      filesGenerated: Object.keys(session.files),
      totalBytesWritten: Object.values(session.files).reduce((acc, f) => acc + (f.size || 0), 0),
      verification: {
        runsCount: verRuns.length,
        failedRuns: verRuns.filter((r) => !r.passed).length,
        passedRuns: verRuns.filter((r) => r.passed).length,
        runs: verRuns.map((r, i) => ({
          run: r.run || i + 1,
          pass: r.pass || i + 1,
          phase: r.phase || 'verify',
          reworkAttempt: r.reworkAttempt || 0,
          passed: r.passed,
          checksPassed: r.passedCount,
          checksTotal: r.checks.length,
        })),
        finalPassed: lastVerification ? lastVerification.passed : false,
        checksPassed: lastVerification ? lastVerification.passedCount : 0,
        checksTotal: lastVerification ? lastVerification.checks.length : 0,
      },
      rubric: session.rubricEvaluation,
      telemetry: {
        totalCalls: tel.totalCalls,
        liveCalls: tel.liveCalls,
        simulatedCalls: tel.simulatedCalls,
        totalTokensUsed: tel.totalTokensUsed,
        totalReasoningTokens: tel.totalReasoningTokens,
        currentTpm: tel.currentTpm,
        tpmLimit: tel.tpmLimit,
        tpmUtilizationPct: tel.tpmUtilizationPct,
        avgLatencyMs: tel.avgLatencyMs,
        p50LatencyMs: tel.p50LatencyMs,
        p95LatencyMs: tel.p95LatencyMs,
        minLatencyMs: tel.minLatencyMs,
        maxLatencyMs: tel.maxLatencyMs,
        latencies: tel.latencies || [],
        retryCount: tel.retryCount,
      },
      generatedAt: new Date().toISOString(),
    };

    session.benchmark = benchmark;
    return benchmark;
  }

  async executeSwarm(session) {
    session.status = 'running';
    this.emitEvent(session, 'session_status', { status: 'running' });

    const onProgress = (ev) => this.emitEvent(session, ev.type, ev);

    try {
      // =========================================================================
      // STAGE 1: @architect analyzes user request, creates brief.md, runbook.md,
      //          populates Kanban tasks, and messages @builder & @verifier
      // =========================================================================
      this.emitEvent(session, 'agent_active', { agentId: 'architect', phase: 'Architecture & Kanban Planning' });

      const archPrompt = architectPrompt(session);

      const archRes = await this.client.chatCompletion({
        agentId: 'architect',
        maxTokens: 8000,
        timeoutMs: CONFIG.longRequestTimeoutMs,
        temperature: 0.2,
        onProgress,
        messages: [
          { role: 'system', content: loadSoul('architect') },
          { role: 'user', content: archPrompt },
        ],
      });

      const archParsed = extractJsonBlock(archRes.content, (o) => typeof o.briefMd === 'string');
      recordModelReply(session, {
        agent: '@architect',
        phase: 'architecture',
        res: archRes,
        parse: { parsedJson: Boolean(archParsed), keys: archParsed ? Object.keys(archParsed) : [] },
      });
      const archDefault = architectFallbackPlan(session);
      const archPlan = { ...archDefault, ...(archParsed || {}) };
      const archDocSource = (key) =>
        typeof archParsed?.[key] === 'string' ? replySource(archRes) : 'engine_fallback';

      if (session.scenarioId) {
        session._cleanArtifacts = buildScenarioArtifacts(session.scenarioId);
        this.writeWorkspaceFile(session, 'brief.md', session._cleanArtifacts['brief.md'], 'engine', 'scenario_fixture');
        this.writeWorkspaceFile(session, 'runbook.md', session._cleanArtifacts['runbook.md'], 'engine', 'scenario_fixture');
      } else {
        this.writeWorkspaceFile(session, 'brief.md', archPlan.briefMd, archDocSource('briefMd') === 'engine_fallback' ? 'engine' : '@architect', archDocSource('briefMd'));
        this.writeWorkspaceFile(session, 'runbook.md', archPlan.runbookMd, archDocSource('runbookMd') === 'engine_fallback' ? 'engine' : '@architect', archDocSource('runbookMd'));
      }

      for (const t of archPlan.kanbanTasks || []) {
        this.createKanbanTask(session, t);
      }

      this.postBotMessage(session, {
        from: '@architect',
        to: '@builder',
        delivery: 'steer',
        content: archPlan.messageToBuilder || `@builder Spec is ready in brief.md and runbook.md. Start TASK-1.`,
        reasoning: archRes.reasoningContent,
        metadata: { phase: 'architecture_handoff', taskId: 'TASK-1', tokens: archRes.usage?.totalTokens || 0, reasoningTokens: archRes.usage?.reasoningTokens || 0, latencyMs: archRes.latencyMs || 0 },
      });

      this.postBotMessage(session, {
        from: '@architect',
        to: '@verifier',
        delivery: 'queue',
        content: archPlan.messageToVerifier || `@verifier Prepare runtime verification suite for TASK-2.`,
        reasoning: '',
        metadata: { phase: 'verification_prep', taskId: 'TASK-2' },
      });

      // =========================================================================
      // STAGE 2: @builder receives handoff, negotiates/confirms contract with
      //          @architect, and writes app.js, index.html, and test.js
      // =========================================================================
      this.updateKanbanTask(session, 'TASK-1', {
        status: 'in_progress',
        author: '@builder',
        comment: 'Claimed TASK-1. Reading brief.md and runbook.md to implement app.js, index.html, and test.js.',
      });
      this.emitEvent(session, 'agent_active', { agentId: 'builder', phase: 'Code Implementation (TASK-1)' });

      const builderPromptFor = (tight) => builderPrompt(session, archPlan, tight);

      const callBuilder = (tight) =>
        this.client.chatCompletion({
          agentId: 'builder',
          maxTokens: 32000,
          timeoutMs: CONFIG.longRequestTimeoutMs,
          temperature: tight ? 0.1 : 0.2,
          reasoningEffort: 'low',
          onProgress,
          messages: [
            { role: 'system', content: loadSoul('builder') },
            { role: 'user', content: builderPromptFor(tight) },
          ],
        });

      let builderRes = await callBuilder(false);
      let builderPatch = extractFilePatch(builderRes.content, ['app.js', 'index.html', 'test.js']);
      const builderRetryReason =
        !Object.keys(builderPatch.files).length && builderRes.finishReason === 'length'
          ? 'finish_reason_length_no_files'
          : null;
      const builderRejected = Object.keys(builderPatch.files).filter((p) => isProtectedScenarioFile(session, p));
      recordModelReply(session, {
        agent: '@builder',
        phase: 'build',
        res: builderRes,
        parse: { parsedJson: builderPatch.parsedJson, format: builderPatch.format, files: Object.keys(builderPatch.files), rejectedProtectedFiles: builderRejected, retryReason: builderRetryReason },
      });
      if (builderRetryReason) {
        builderRes = await callBuilder(true);
        builderPatch = extractFilePatch(builderRes.content, ['app.js', 'index.html', 'test.js']);
        recordModelReply(session, {
          agent: '@builder',
          phase: 'build_retry',
          res: builderRes,
          parse: { parsedJson: builderPatch.parsedJson, format: builderPatch.format, files: Object.keys(builderPatch.files), rejectedProtectedFiles: Object.keys(builderPatch.files).filter((p) => isProtectedScenarioFile(session, p)), retryOf: 'build', retryReason: builderRetryReason },
        });
      }
      const builderOut = builderPatch.parsedJson
        ? { ...(extractJsonBlock(builderRes.content) || {}), files: builderPatch.files }
        : null;
      const builderSource = replySource(builderRes);
      const writtenByBuilder = [];
      const fileEntries = Object.entries(builderPatch.files).filter(([relPath, code]) => {
        if (typeof code !== 'string') return false;
        if (isProtectedScenarioFile(session, relPath)) {
          this.recordRejectedProtectedWrite(session, relPath, code, '@builder');
          return false;
        }
        if (session.scenarioId && relPath === 'app.js' && isHostileScenarioAppJs(code)) {
          this.recordRejectedWrite(session, relPath, code, '@builder', 'rejected_contract');
          return false;
        }
        return true;
      });
      if (fileEntries.length) {
        await this.runParallelTasks(
          session,
          fileEntries.map(([relPath, code]) => ({
            id: `write:${relPath}`,
            title: `Write & validate ${relPath}`,
            relPath,
            code,
          })),
          async (spec) => {
            const written = this.writeWorkspaceFile(session, spec.relPath, spec.code, '@builder', builderSource);
            if (written) writtenByBuilder.push(spec.relPath);
            return { path: spec.relPath, bytes: Buffer.byteLength(spec.code, 'utf8') };
          }
        );
      }
      // Scenario fixtures fill gaps the model omitted (always domain.js) or a truncated reply.
      if (session.scenarioId && session._cleanArtifacts) {
        for (const relPath of ['domain.js', 'app.js', 'test.js', 'index.html']) {
          if (!writtenByBuilder.includes(relPath)) {
            this.writeWorkspaceFile(session, relPath, session._cleanArtifacts[relPath], 'engine', 'scenario_fixture');
          }
        }
      } else if (!writtenByBuilder.includes('app.js')) {
        this.writeFallbackArtifacts(session);
      }

      this.postBotMessage(session, {
        from: '@builder',
        to: '@architect',
        delivery: 'notify',
        content:
          builderOut?.messageToArchitect ||
          `@architect Implemented isomorphic app.js, interactive index.html, and automated assertions in test.js per runbook.md.`,
        reasoning: builderRes.reasoningContent,
        metadata: { phase: 'builder_ack', taskId: 'TASK-1', tokens: builderRes.usage?.totalTokens || 0, reasoningTokens: builderRes.usage?.reasoningTokens || 0, latencyMs: builderRes.latencyMs || 0 },
      });

      this.postBotMessage(session, {
        from: '@builder',
        to: '@verifier',
        delivery: 'steer',
        content:
          builderOut?.messageToVerifier ||
          `@verifier TASK-1 implementation is complete. Please execute test.js in the sandbox and audit app.js & index.html.`,
        reasoning: '',
        metadata: { phase: 'review_request', taskId: 'TASK-2' },
      });

      this.updateKanbanTask(session, 'TASK-1', {
        status: 'done',
        author: '@builder',
        comment: `Wrote ${Object.keys(session.files).join(', ')}. Ready for @verifier.`,
      });

      // =========================================================================
      // STAGE 3: @verifier runs sandbox tests, critiques code, and triggers an
      //          autonomous rework loop with @builder if needed
      // =========================================================================
      this.updateKanbanTask(session, 'TASK-2', {
        status: 'in_progress',
        author: '@verifier',
        comment: 'Running automated syntax & runtime tests (node test.js) and auditing code.',
      });
      this.emitEvent(session, 'agent_active', { agentId: 'verifier', phase: 'Sandbox Verification & QA Audit (TASK-2)' });

      let savedCleanFiles = null;
      if (session.simulateBrokenFirstPass) {
        if (session.scenarioId && session._cleanArtifacts) {
          const fault = applyPass1Fault(session._cleanArtifacts, session.scenarioId);
          savedCleanFiles = { [fault.file]: fault.clean };
          this.writeWorkspaceFile(session, fault.file, fault.broken, 'engine', 'fault_injection');
        } else if (session.files['app.js']) {
          const clean = session.files['app.js'].content;
          savedCleanFiles = { 'app.js': clean };
          this.writeWorkspaceFile(session, 'app.js', injectGenericPass1Fault(clean), 'engine', 'fault_injection');
        }
      }
      let testRun = this.runWorkspaceTests(session, { pass: 1, phase: 'pass1_initial' });
      if (testRun.passed && session.scenarioId && session._cleanArtifacts) {
        this.applyIndependentGrade(testRun, this.runIndependentScenarioGrade(session));
      }
      if (!session.reworkSummary) session.reworkSummary = [];

      // Autonomous self-healing rework loop (up to this.maxReworkLoops attempts)
      let reworkAttempt = 0;
      while (!testRun.passed && reworkAttempt < this.maxReworkLoops) {
        reworkAttempt += 1;
        session.reworkCycles = reworkAttempt;
        session._captureReworkDiff = true;
        const targets = reworkTargetFiles(session, testRun);

        this.updateKanbanTask(session, 'TASK-1', {
          status: 'rework',
          author: '@verifier',
          comment: `Rework #${reworkAttempt}: Sandbox test failed (${testRun.stderr.slice(0, 220)}). Requesting targeted fix from @builder for ${targets.join(', ')}.`,
        });

        const readOnlyTests = sessionProtectedFiles(session).filter((p) => session.files[p]);
        this.postBotMessage(session, {
          from: '@verifier',
          to: '@builder',
          delivery: 'steer',
          content: `@builder [Rework Cycle #${reworkAttempt}] Sandbox execution of \`node test.js\` reported an error:\n\`\`\`\n${testRun.stderr.slice(0, 400)}\n\`\`\`\nPlease patch ${targets.map((t) => `\`${t}\``).join(', ') || 'the implementation files'}. \`test.js\` is read-only grading and must not be edited.`,
          metadata: { phase: 'rework_request', taskId: 'TASK-1', reworkAttempt, targetFiles: targets, readOnlyFiles: readOnlyTests },
        });

        this.emitEvent(session, 'agent_active', {
          agentId: 'builder',
          phase: `Rework Loop Fix #${reworkAttempt} (TASK-1)`,
        });

        const failOutFull = `${testRun.stdout || ''}\n${testRun.stderr || ''}`.trim();
        const writableBlock = targets.map((t) => `--- ${t} ---\n${session.files[t]?.content || ''}`).join('\n\n') || '(none)';
        const fixPromptFor = (tight) => reworkFixPrompt(session, { reworkAttempt, failOutFull, writableBlock, readOnlyTests, targets }, tight);
        const callFix = (tight) =>
          this.client.chatCompletion({
            agentId: 'builder',
            maxTokens: 32000,
            timeoutMs: CONFIG.longRequestTimeoutMs,
            temperature: 0.1,
            reasoningEffort: 'low',
            onProgress,
            messages: [
              { role: 'system', content: loadSoul('builder') },
              { role: 'user', content: fixPromptFor(tight) },
            ],
          });

        let fixRes = await callFix(false);
        const fixRetryReason = isEmptyLengthReply(fixRes) ? 'finish_reason_length_empty_content' : null;
        if (fixRetryReason) {
          recordModelReply(session, {
            agent: '@builder',
            phase: 'rework_fix',
            reworkAttempt,
            res: fixRes,
            parse: { retryReason: fixRetryReason, targetFiles: targets },
          });
          fixRes = await callFix(true);
        }

        const patch = extractFilePatch(fixRes.content, Object.keys(session.files));
        const patchSource = replySource(fixRes);
        const rejectedProtectedFiles = [];
        const rejectedNonTargets = [];
        const rejectedGradingCheckFiles = [];
        const changed = [];
        for (const [relPath, code] of Object.entries(patch.files)) {
          if (typeof code !== 'string') continue;
          if (isProtectedScenarioFile(session, relPath)) {
            this.recordRejectedWrite(session, relPath, code, '@builder', 'rejected_protected_file');
            rejectedProtectedFiles.push(relPath);
            continue;
          }
          if (isScenarioReworkNonTarget(session, relPath)) {
            this.recordRejectedWrite(session, relPath, code, '@builder', 'rejected_non_target');
            rejectedNonTargets.push(relPath);
            continue;
          }
          if (scenarioFaultFiles(session).includes(relPath) && patchSource === 'model') {
            const scan = scanModelFaultSource(code, scenarioAllowedLocals(session));
            if (scan.length) {
              this.recordRejectedWrite(session, relPath, code, '@builder', 'rejected_grading_check');
              rejectedGradingCheckFiles.push(relPath);
              continue;
            }
          }
          if (session.files[relPath]?.content !== code) changed.push([relPath, code]);
        }
        const prePatch = Object.fromEntries(changed.map(([relPath]) => [relPath, session.files[relPath]?.content]));
        const runsBefore = session.verificationRuns.length;
        let modelPatch = changed.length
          ? 'applied'
          : rejectedProtectedFiles.length && !Object.keys(patch.files).some((p) => !rejectedProtectedFiles.includes(p) && !rejectedNonTargets.includes(p) && !rejectedGradingCheckFiles.includes(p))
            ? 'rejected_protected_file'
            : rejectedGradingCheckFiles.length && !changed.length
              ? 'rejected_grading_check'
              : rejectedNonTargets.length && !changed.length
                ? 'rejected_non_target'
                : Object.keys(patch.files).length
                  ? 'unchanged'
                  : 'missing';
        let healedBy = null;

        const markDiffs = (fromIdx, passed) => {
          for (const d of session.reworkDiffs.slice(fromIdx)) d.verifiedPass = passed;
        };

        if (changed.length) {
          const diffIdx = session.reworkDiffs.length;
          for (const [relPath, code] of changed) this.writeWorkspaceFile(session, relPath, code, '@builder', patchSource);
          testRun = this.runWorkspaceTests(session, {
            pass: reworkAttempt + 1,
            phase: 'rework_verify',
            reworkAttempt,
            candidate: patchSource,
          });
          if (testRun.passed && session.scenarioId && session._cleanArtifacts && patchSource === 'model') {
            const grade = this.runIndependentScenarioGrade(session);
            this.applyIndependentGrade(testRun, grade);
            if (!grade.passed) {
              for (const [relPath, code] of changed) {
                this.recordRejectedWrite(session, relPath, code, '@builder', 'rejected_grading_check');
                rejectedGradingCheckFiles.push(relPath);
                if (prePatch[relPath] != null) {
                  this.writeWorkspaceFile(session, relPath, prePatch[relPath], 'engine', 'deterministic_restore');
                }
              }
              modelPatch = 'rejected_grading_check';
              healedBy = null;
              markDiffs(diffIdx, false);
            } else {
              modelPatch = 'passed';
              healedBy = patchSource;
              markDiffs(diffIdx, true);
            }
          } else {
            markDiffs(diffIdx, testRun.passed);
            modelPatch = testRun.passed ? 'passed' : 'failed';
            if (testRun.passed) healedBy = patchSource;
          }
        }

        // Engine fallback: only when the reply had no usable patch, an unchanged patch, or a patch
        // that still fails. A passing model patch is never overwritten.
        if (!testRun.passed && savedCleanFiles) {
          const diffIdx = session.reworkDiffs.length;
          for (const [relPath, code] of Object.entries(prePatch)) {
            if (!savedCleanFiles[relPath] && session.files[relPath]?.content !== code) {
              this.writeWorkspaceFile(session, relPath, code, 'engine', 'deterministic_restore');
            }
          }
          if (session._cleanArtifacts) {
            this.restoreScenarioCodeFixtures(session, 'deterministic_restore');
          } else {
            for (const [relPath, code] of Object.entries(savedCleanFiles)) {
              if (session.files[relPath]?.content !== code) {
                this.writeWorkspaceFile(session, relPath, code, 'engine', 'deterministic_restore');
              }
            }
          }
          testRun = this.runWorkspaceTests(session, {
            pass: reworkAttempt + 1,
            phase: changed.length ? 'restore_verify' : 'rework_verify',
            reworkAttempt,
            candidate: 'deterministic_restore',
          });
          markDiffs(diffIdx, testRun.passed);
          if (testRun.passed) healedBy = 'deterministic_restore';
        }
        if (!testRun.passed && reworkAttempt >= this.maxReworkLoops) {
          this.writeFallbackArtifacts(session);
          testRun = this.runWorkspaceTests(session, {
            pass: reworkAttempt + 1,
            phase: 'fallback_verify',
            reworkAttempt,
            candidate: 'engine_fallback',
          });
          if (testRun.passed) healedBy = 'engine_fallback';
        }

        const reply = recordModelReply(session, {
          agent: '@builder',
          phase: fixRetryReason ? 'rework_fix_retry' : 'rework_fix',
          reworkAttempt,
          res: fixRes,
          parse: {
            parsedJson: patch.parsedJson,
            format: patch.format,
            files: Object.keys(patch.files),
            rejectedProtectedFiles,
            rejectedNonTargets,
            rejectedGradingCheckFiles,
            modelPatch,
            targetFiles: targets,
            readOnlyFiles: readOnlyTests,
            retryOf: fixRetryReason ? 'rework_fix' : undefined,
            retryReason: fixRetryReason || undefined,
          },
        });
        session.reworkSummary.push({
          reworkAttempt,
          targetFiles: targets,
          modelReply: { simulated: reply.simulated, finishReason: reply.finishReason, parsedJson: patch.parsedJson, format: patch.format, files: Object.keys(patch.files), rejectedProtectedFiles, rejectedNonTargets, rejectedGradingCheckFiles },
          modelPatch,
          filesPatchedByModel: modelPatch === 'rejected_grading_check' ? [] : changed.map(([relPath]) => relPath),
          rejectedProtectedFiles,
          rejectedNonTargets,
          rejectedGradingCheckFiles,
          healedBy,
          verificationRuns: session.verificationRuns.slice(runsBefore).map((r) => ({ run: r.run, phase: r.phase, passed: r.passed })),
        });

        const modelFixed = healedBy === 'model' || healedBy === 'offline_fixture';
        this.postBotMessage(session, {
          from: '@builder',
          to: '@verifier',
          delivery: 'steer',
          content: modelFixed
            ? patch.message || `@verifier Rework #${reworkAttempt}: patched ${changed.map(([p]) => p).join(', ')}. Re-run verification.`
            : `@verifier Rework #${reworkAttempt}: my patch was ${modelPatch}; the engine restored the pre-fault ${Object.keys(savedCleanFiles || {}).join(', ') || 'sources'} (${healedBy || 'no heal'}). Re-run verification.`,
          reasoning: fixRes.reasoningContent,
          metadata: { phase: 'rework_complete', taskId: 'TASK-1', reworkAttempt, healedBy, modelPatch, tokens: fixRes.usage?.totalTokens || 0, reasoningTokens: fixRes.usage?.reasoningTokens || 0, latencyMs: fixRes.latencyMs || 0 },
        });

        if (testRun.passed) {
          this.updateKanbanTask(session, 'TASK-1', {
            status: 'done',
            author: healedBy === 'model' ? '@builder' : 'engine',
            comment: `Rework #${reworkAttempt} verified green (healed by ${healedBy}).`,
          });
        }
      }

      // Compute deterministic rubric baseline & run @verifier LLM audit
      const rubricEval = this.evaluateDeterministicRubric(session, testRun);

      const verifierPrompt = verifierAuditPrompt(session, testRun, rubricEval);

      const verifierRes = await this.client.chatCompletion({
        agentId: 'verifier',
        maxTokens: 2500,
        temperature: 0.2,
        onProgress,
        messages: [
          { role: 'system', content: loadSoul('verifier') },
          { role: 'user', content: verifierPrompt },
        ],
      });

      const verifierParsed = extractJsonBlock(verifierRes.content, (o) => o.verdict !== undefined || o.qualityScore !== undefined);
      recordModelReply(session, {
        agent: '@verifier',
        phase: 'audit',
        res: verifierRes,
        parse: { parsedJson: Boolean(verifierParsed), keys: verifierParsed ? Object.keys(verifierParsed) : [] },
      });
      const verifierOut = verifierParsed || {
        verdict: testRun.passed ? 'VERIFIED_PASS' : 'VERIFIED_FAIL',
        qualityScore: rubricEval.totalScore,
        rubric: rubricEval.breakdown,
        messageToBuilder: `@builder Code audit complete. Syntax checks and runtime assertions in test.js ${testRun.passed ? 'passed' : 'failed'} (${testRun.checks.length} checks, rubric ${rubricEval.totalScore}/100).`,
        messageToLead: `@lead Verification ${testRun.passed ? 'passed (VERIFIED_PASS)' : 'failed (VERIFIED_FAIL)'}. Handing off TASK-3 for release documentation and synthesis.`,
      };

      if (session.scenarioId && session._cleanArtifacts && testRun.passed) {
        if (!(testRun.checks || []).some((c) => c.name === 'independent_grade')) {
          this.applyIndependentGrade(testRun, this.runIndependentScenarioGrade(session));
        }
      }
      const anyRunPassed = (session.verificationRuns || []).some((r) => r.passed);
      const independentOk =
        !session.scenarioId ||
        (testRun.checks || []).some((c) => c.name === 'independent_grade' && c.passed);
      const honestPass = Boolean(testRun.passed && anyRunPassed && independentOk);

      const verdict = honestPass ? (verifierOut.verdict === 'VERIFIED_FAIL' ? 'VERIFIED_FAIL' : 'VERIFIED_PASS') : 'VERIFIED_FAIL';
      const failRubric = {
        correctness: 0,
        testCoverage: 0,
        architectureAdherence: rubricEval.breakdown.architectureAdherence,
        uiCompleteness: rubricEval.breakdown.uiCompleteness,
      };
      session.rubricEvaluation = {
        verdict,
        qualityScore: verdict === 'VERIFIED_FAIL'
          ? failRubric.architectureAdherence + failRubric.uiCompleteness
          : (Number.isFinite(Number(verifierOut.qualityScore)) ? Number(verifierOut.qualityScore) : rubricEval.totalScore),
        rubric: verdict === 'VERIFIED_FAIL' ? failRubric : (verifierOut.rubric || rubricEval.breakdown),
        invariants: rubricEval.invariants,
      };

      this.postBotMessage(session, {
        from: '@verifier',
        to: '@builder',
        delivery: 'notify',
        content: verifierOut.messageToBuilder,
        reasoning: verifierRes.reasoningContent,
        metadata: {
          phase: 'verification_verdict', tokens: verifierRes.usage?.totalTokens || 0, reasoningTokens: verifierRes.usage?.reasoningTokens || 0, latencyMs: verifierRes.latencyMs || 0,
          verdict: session.rubricEvaluation.verdict,
          score: session.rubricEvaluation.qualityScore,
          rubric: session.rubricEvaluation.rubric,
        },
      });

      this.postBotMessage(session, {
        from: '@verifier',
        to: '@lead',
        delivery: 'steer',
        content: verifierOut.messageToLead,
        reasoning: '',
        metadata: { phase: 'lead_handoff', taskId: 'TASK-3' },
      });

      this.updateKanbanTask(session, 'TASK-2', {
        status: 'done',
        author: '@verifier',
        comment: `Verdict: ${session.rubricEvaluation.verdict} (Score: ${session.rubricEvaluation.qualityScore}/100). Sandbox output: ${testRun.stdout.trim().slice(0, 200)}`,
      });

      // =========================================================================
      // STAGE 4: @lead synthesizes README.md, benchmark.json, and final report
      // =========================================================================
      this.updateKanbanTask(session, 'TASK-3', {
        status: 'in_progress',
        author: '@lead',
        comment: 'Synthesizing README.md, benchmark telemetry, and multi-agent collaboration report.',
      });
      this.emitEvent(session, 'agent_active', { agentId: 'lead', phase: 'Documentation & Launch Synthesis (TASK-3)' });

      const leadPromptFor = (tight) => leadReleasePrompt(session, testRun, tight);

      const callLead = (tight) =>
        this.client.chatCompletion({
          agentId: 'lead',
          maxTokens: 16000,
          temperature: tight ? 0.1 : 0.3,
          timeoutMs: CONFIG.longRequestTimeoutMs,
          reasoningEffort: 'low',
          onProgress,
          messages: [
            { role: 'system', content: loadSoul('lead') },
            { role: 'user', content: leadPromptFor(tight) },
          ],
        });
      const isLeadOut = (o) => typeof o.readmeMd === 'string';
      const leadParseInfo = (parsed) => ({ parsedJson: Boolean(parsed), keys: parsed ? Object.keys(parsed) : [] });

      let leadRes = await callLead(false);
      let leadParsed = extractJsonBlock(leadRes.content, isLeadOut);
      const leadRetryReason =
        !leadParsed && leadRes.finishReason === 'length' && !String(leadRes.content || '').trim()
          ? 'finish_reason_length_empty_content'
          : null;
      recordModelReply(session, {
        agent: '@lead',
        phase: 'release',
        res: leadRes,
        parse: { ...leadParseInfo(leadParsed), retryReason: leadRetryReason },
      });
      if (leadRetryReason) {
        leadRes = await callLead(true);
        leadParsed = extractJsonBlock(leadRes.content, isLeadOut);
        recordModelReply(session, {
          agent: '@lead',
          phase: 'release_retry',
          res: leadRes,
          parse: { ...leadParseInfo(leadParsed), retryOf: 'release', retryReason: leadRetryReason },
        });
      }
      if (leadParsed && !isLeadOut(leadParsed)) leadParsed = null;
      const leadSource = replySource(leadRes);
      const leadDefault = leadFallbackPlan(session, archPlan);

      const leadOut = { ...leadDefault, ...(leadParsed || {}) };
      // A live @lead README wins; offline, the richer scenario README beats the canned offline reply.
      if (leadParsed && leadSource === 'model') {
        this.writeWorkspaceFile(session, 'README.md', leadParsed.readmeMd, '@lead', 'model');
      } else if (session._cleanArtifacts?.['README.md']) {
        this.writeWorkspaceFile(session, 'README.md', session._cleanArtifacts['README.md'], 'engine', 'scenario_fixture');
      } else if (leadParsed) {
        this.writeWorkspaceFile(session, 'README.md', leadParsed.readmeMd, '@lead', leadSource);
      } else {
        this.writeWorkspaceFile(session, 'README.md', leadDefault.readmeMd, 'engine', 'engine_fallback');
      }

      this.postBotMessage(session, {
        from: '@lead',
        to: '@all',
        delivery: 'notify',
        content: leadOut.finalBroadcast,
        reasoning: leadRes.reasoningContent,
        metadata: { phase: 'session_complete', source: typeof leadParsed?.finalBroadcast === 'string' ? leadSource : 'engine_fallback', taskId: 'TASK-3', tokens: leadRes.usage?.totalTokens || 0, reasoningTokens: leadRes.usage?.reasoningTokens || 0, latencyMs: leadRes.latencyMs || 0 },
      });

      this.updateKanbanTask(session, 'TASK-3', {
        status: 'done',
        author: '@lead',
        comment: 'Generated README.md, benchmark.json, and published final release synthesis.',
      });

      session.status = 'completed';
      session.completedAt = new Date().toISOString();

      const benchmark = this.generateBenchmarkSummary(session);
      this.writeWorkspaceFile(session, 'benchmark.json', JSON.stringify(benchmark, null, 2), 'engine', 'engine_summary');
      this.saveSessionSnapshot(session);

      this.emitEvent(session, 'session_completed', {
        session: this.serializeSession(session),
        benchmark,
      });

      return session;
    } catch (err) {
      session.status = 'error';
      session.error = err.message;
      this.saveSessionSnapshot(session);
      this.emitEvent(session, 'session_error', { error: err.message });
      throw err;
    }
  }

  serializeSession(session) {
    if (!session) return null;
    return {
      id: session.id,
      slug: session.slug,
      prompt: session.prompt,
      scenarioId: session.scenarioId || null,
      workspaceDir: session.workspaceDir,
      status: session.status,
      createdAt: session.createdAt,
      completedAt: session.completedAt,
      agents: session.agents,
      messages: session.messages,
      kanban: session.kanban,
      files: Object.values(session.files),
      fileHistory: session.fileHistory || {},
      reworkDiffs: session.reworkDiffs || [],
      reworkSummary: session.reworkSummary || [],
      healedBy: Array.isArray(session.healedBy) && session.healedBy.length
        ? session.healedBy
        : (session.reworkSummary || []).map((c) => c.healedBy),
      golden: Boolean(session.golden),
      readOnly: Boolean(session.readOnly),
      modelReplies: session.modelReplies || [],
      verificationRuns: session.verificationRuns,
      parallelTasksRun: session.parallelTasksRun || [],
      reworkCycles: session.reworkCycles || 0,
      rubricEvaluation: session.rubricEvaluation || null,
      benchmark: session.benchmark || null,
      protectedFiles: sessionProtectedFiles(session),
      ObserverAdvisories: session.ObserverAdvisories,
      telemetry: session.telemetry || (session._telSnap ? this.client.telemetrySince(session._telSnap) : this.client.getTelemetry()),
    };
  }
}

Object.assign(MuseSwarmEngine.prototype, workspaceMethods);

module.exports = {
  MuseSwarmEngine,
  AGENT_PROFILES,
  extractJsonBlock,
  SCENARIO_PRESETS,
  resolveScenarioId,
  serializeScenarios,
  buildReworkDiff,
};
