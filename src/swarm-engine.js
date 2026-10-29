const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const EventEmitter = require('events');
const { CONFIG } = require('./config');
const { BasetenMuseClient } = require('./baseten-client');
const {
  SCENARIO_PRESETS,
  getScenario,
  resolveScenarioId,
  buildScenarioArtifacts,
  applyPass1Fault,
  isScenarioTestFile,
  scenarioTestFiles,
  serializeScenarios,
} = require('./scenarios');
const { extractJson, extractFilePatch } = require('./reply-parser');
const { scenarioAppLoadsDomain, scanModelFaultSource, runIsolatedDomainGrade } = require('./isolated-grade');

const AGENT_PROFILES = {
  architect: {
    id: 'architect',
    handle: '@architect',
    name: 'Architect Bot',
    role: 'System Architect & Kanban Arbiter',
    color: '#6366f1',
    badge: 'ARCHITECT',
    toolsets: ['kanban', 'clarify', 'file_spec', 'session_message'],
  },
  builder: {
    id: 'builder',
    handle: '@builder',
    name: 'Builder Bot',
    role: 'Full-Stack Implementation Specialist',
    color: '#10b981',
    badge: 'BUILDER',
    toolsets: ['kanban', 'file_write', 'parallel_fanout', 'terminal_check', 'session_message'],
  },
  verifier: {
    id: 'verifier',
    handle: '@verifier',
    name: 'Verifier & Critic Bot',
    role: 'Autonomous QA, Runtime Test & Security Critic',
    color: '#f59e0b',
    badge: 'VERIFIER',
    toolsets: ['kanban', 'test_runner', 'rubric_scorer', 'code_review', 'session_message'],
  },
  lead: {
    id: 'lead',
    handle: '@lead',
    name: 'Synthesizer & DevRel Bot',
    role: 'Release Synthesizer & Technical Writer',
    color: '#ec4899',
    badge: 'LEAD',
    toolsets: ['kanban', 'file_write', 'benchmark_report', 'synthesis', 'session_message'],
  },
};

function loadSoul(agentId) {
  const soulPath = path.join(CONFIG.profilesDir, agentId, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    return fs.readFileSync(soulPath, 'utf8');
  }
  return `You are @${agentId} in a MuseSwarm multi-agent engineering team.`;
}

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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sessionProtectedFiles(session) {
  if (session?._cleanArtifacts) return scenarioTestFiles(session._cleanArtifacts);
  if (session?.scenarioId) return ['test.js'];
  return [];
}

function isProtectedScenarioFile(session, relPath) {
  if (!relPath) return false;
  const protectedSet = new Set(sessionProtectedFiles(session));
  if (protectedSet.has(relPath)) return true;
  return Boolean(session?.scenarioId || session?._cleanArtifacts) && isScenarioTestFile(relPath);
}

function scenarioFaultFiles(session) {
  const preset = getScenario(session?.scenarioId);
  const file = preset?.pass1Fault?.file;
  return file ? [file] : [];
}

function isScenarioReworkNonTarget(session, relPath) {
  if (!session?.scenarioId) return false;
  if (isProtectedScenarioFile(session, relPath)) return false;
  const faultFiles = scenarioFaultFiles(session);
  return faultFiles.length > 0 && !faultFiles.includes(relPath);
}

function scenarioAllowedLocals(session) {
  const arts = session?._cleanArtifacts || {};
  return Object.keys(arts).filter((p) => p.endsWith('.js') && !isScenarioTestFile(p));
}

function isHostileScenarioAppJs(content) {
  const text = String(content || '');
  if (!scenarioAppLoadsDomain(text)) return true;
  return scanModelFaultSource(text, ['domain.js']).includes('assert')
    || /\brequire\s*\(\s*['"](?:node:)?assert['"]\s*\)/.test(text)
    || /\brequire\.cache\b/.test(text);
}

function isKeptModelScenarioFile(session, relPath) {
  const file = session?.files?.[relPath];
  if (!file || (file.source !== 'model' && file.source !== 'offline_fixture')) return false;
  if (isScenarioTestFile(relPath)) return false;
  if (scenarioFaultFiles(session).includes(relPath)) return false;
  if (relPath === 'app.js') return !isHostileScenarioAppJs(file.content);
  if (relPath === 'index.html') return true;
  return false;
}

// Files named in the failing output (stack frames, syntax checks) plus their local require() deps,
// so a failure surfacing in test.js also hands @builder the module under test (e.g. domain.js).
// Scenario grading tests are read-only; scenario rework may only patch the seeded fault file.
function reworkTargetFiles(session, testRun) {
  if (session.scenarioId) {
    return scenarioFaultFiles(session).filter((p) => session.files[p] && !isProtectedScenarioFile(session, p));
  }
  const jsFiles = Object.keys(session.files).filter((p) => p.endsWith('.js'));
  const output = `${testRun.stderr || ''}\n${testRun.stdout || ''}`;
  const hits = new Set();
  for (const p of jsFiles) {
    if (new RegExp(`(^|[\\\\/\\s(])${escapeRegExp(p)}(:\\d+|\\b)`).test(output)) hits.add(p);
  }
  for (const check of testRun.checks || []) {
    if (!check.passed && check.name.startsWith('syntax:')) hits.add(check.name.slice('syntax:'.length));
  }
  if (!hits.size) jsFiles.forEach((p) => hits.add(p));
  const queue = [...hits];
  while (queue.length) {
    const src = session.files[queue.shift()]?.content || '';
    for (const m of src.matchAll(/require\(\s*['"]\.\/([\w./-]+?)(?:\.js)?['"]\s*\)/g)) {
      const dep = `${m[1]}.js`;
      if (session.files[dep] && !hits.has(dep)) {
        hits.add(dep);
        queue.push(dep);
      }
    }
  }
  return jsFiles.filter((p) => hits.has(p) && !isProtectedScenarioFile(session, p));
}

// ponytail: O(n*m) line LCS. Fine for workspace files under a few thousand lines; switch to Myers if artifacts grow past that.
function diffLineOps(beforeLines, afterLines) {
  const n = beforeLines.length;
  const m = afterLines.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = beforeLines[i] === afterLines[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  let oldLine = 1;
  let newLine = 1;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ t: ' ', line: beforeLines[i], oldLine, newLine });
      i += 1;
      j += 1;
      oldLine += 1;
      newLine += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: '-', line: beforeLines[i], oldLine, newLine: null });
      i += 1;
      oldLine += 1;
    } else {
      ops.push({ t: '+', line: afterLines[j], oldLine: null, newLine });
      j += 1;
      newLine += 1;
    }
  }
  while (i < n) {
    ops.push({ t: '-', line: beforeLines[i], oldLine, newLine: null });
    i += 1;
    oldLine += 1;
  }
  while (j < m) {
    ops.push({ t: '+', line: afterLines[j], oldLine: null, newLine });
    j += 1;
    newLine += 1;
  }
  return ops;
}

function formatUnifiedDiff(filePath, ops) {
  const context = 3;
  const keep = ops.map((op) => op.t !== ' ');
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].t === ' ') continue;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  }

  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  let idx = 0;
  while (idx < ops.length) {
    if (!keep[idx]) {
      idx += 1;
      continue;
    }
    let end = idx;
    while (end < ops.length && keep[end]) end += 1;
    const hunk = ops.slice(idx, end);
    const oldStart = (hunk.find((op) => op.oldLine) || {}).oldLine || 1;
    const newStart = (hunk.find((op) => op.newLine) || {}).newLine || 1;
    const oldCount = hunk.filter((op) => op.t !== '+').length;
    const newCount = hunk.filter((op) => op.t !== '-').length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) lines.push(op.t + op.line);
    idx = end;
  }
  return lines.join('\n');
}

function lineSnippet(lines, lineNo, radius = 3) {
  const center = Math.max(1, Number(lineNo) || 1);
  const start = Math.max(0, center - 1 - radius);
  const end = Math.min(lines.length, center + radius);
  return lines.slice(start, end).join('\n');
}

function buildReworkDiff({ filePath, before, after, author, source = 'unspecified', reworkAttempt }) {
  const beforeLines = String(before).replace(/\r\n/g, '\n').split('\n');
  const afterLines = String(after).replace(/\r\n/g, '\n').split('\n');
  const ops = diffLineOps(beforeLines, afterLines);
  const firstDel = ops.find((op) => op.t === '-');
  const firstAdd = ops.find((op) => op.t === '+');
  return {
    path: filePath,
    author,
    source,
    fixedBy: source === 'model' ? `${author} (Muse Spark reply)` : `engine (${source})`,
    verifiedPass: null,
    passFrom: 1,
    passTo: (reworkAttempt || 1) + 1,
    reworkAttempt: reworkAttempt || 1,
    diff: formatUnifiedDiff(filePath, ops),
    beforeSnippet: lineSnippet(beforeLines, firstDel ? firstDel.oldLine : 1),
    afterSnippet: lineSnippet(afterLines, firstAdd ? firstAdd.newLine : 1),
    timestamp: new Date().toISOString(),
  };
}

function injectGenericPass1Fault(source) {
  const broken = String(source).replace(
    /const slaBreached = [^;]+;/,
    'const slaBreached = false; // simulated unit-mismatch bug (hours vs ms)'
  );
  if (broken !== source) {
    return `${broken}\n// Intentional pass-1 bug for self-heal verification`;
  }
  return `${source}\nmodule.exports.TaskPriorityEngine = class { addItem() { throw new Error("AssertionError: slaBreached unit mismatch (hours vs ms)"); } };`;
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

  // source: 'model' (parsed from a live Muse Spark reply), 'offline_fixture' (simulated reply),
  // or an engine-authored write: 'scenario_fixture', 'fault_injection', 'deterministic_restore',
  // 'engine_fallback', 'engine_summary'.
  recordRejectedWrite(session, relPath, attemptedContent, authorAgent, source = 'rejected_protected_file') {
    const safeRel = relPath.replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    if (!session.fileHistory) session.fileHistory = {};
    const history = session.fileHistory[safeRel] || (session.fileHistory[safeRel] = []);
    const text = String(attemptedContent);
    history.push({
      revision: history.length + 1,
      author: authorAgent,
      source,
      rejected: true,
      updatedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(text, 'utf8'),
      content: text,
    });
    this.emitEvent(session, 'file_write_rejected', {
      path: safeRel,
      author: authorAgent,
      source,
    });
    return history[history.length - 1];
  }

  recordRejectedProtectedWrite(session, relPath, attemptedContent, authorAgent) {
    return this.recordRejectedWrite(session, relPath, attemptedContent, authorAgent, 'rejected_protected_file');
  }

  // Isolated child-process grade: model's domain.js never shares a process with assert.
  // Parent compares JSON outputs to the clean fixture domain.js (also run in its own child).
  runIndependentScenarioGrade(session, overlay = {}) {
    const artifacts = session._cleanArtifacts;
    if (!artifacts || !session.scenarioId) return { passed: true, skipped: true };
    const faultFile = scenarioFaultFiles(session)[0] || 'domain.js';
    let modelDomain = artifacts[faultFile];
    if (Object.prototype.hasOwnProperty.call(overlay, faultFile)) modelDomain = overlay[faultFile];
    else if (session.files[faultFile]?.content != null) modelDomain = session.files[faultFile].content;
    const grade = runIsolatedDomainGrade(
      session.scenarioId,
      modelDomain,
      artifacts[faultFile],
      scenarioAllowedLocals(session)
    );
    return {
      passed: Boolean(grade.passed),
      skipped: false,
      stdout: '',
      stderr: grade.passed ? '' : `${grade.reason || 'independent grade failed'}${grade.detail ? ': ' + grade.detail : ''}`,
      scan: grade.scan || [],
      reason: grade.reason,
    };
  }

  applyIndependentGrade(testRun, grade) {
    testRun.checks.push({
      name: 'independent_grade',
      passed: grade.passed,
      detail: grade.skipped
        ? 'skipped'
        : grade.passed
          ? 'isolated child-process domain.js outputs matched the fixture'
          : (grade.stderr || grade.reason || 'independent grade failed').trim().slice(0, 400),
    });
    if (!grade.passed) {
      testRun.passed = false;
      testRun.stderr += `\n[independent_grade] ${(grade.stderr || '').trim().slice(0, 400)}`;
    }
    testRun.passedCount = testRun.checks.filter((c) => c.passed).length;
    testRun.failedCount = testRun.checks.filter((c) => !c.passed).length;
    return testRun.passed;
  }

  restoreScenarioCodeFixtures(session, source = 'deterministic_restore', { force = false } = {}) {
    const artifacts = session._cleanArtifacts;
    if (!artifacts) return;
    for (const relPath of ['domain.js', 'app.js', 'test.js', 'index.html']) {
      const fixture = artifacts[relPath];
      if (typeof fixture !== 'string') continue;
      if (!force && isKeptModelScenarioFile(session, relPath)) continue;
      if (session.files[relPath]?.content !== fixture) {
        this.writeWorkspaceFile(session, relPath, fixture, 'engine', source);
      }
    }
  }

  enforceScenarioGradingTests(session) {
    const artifacts = session._cleanArtifacts;
    if (!artifacts) return;
    for (const relPath of sessionProtectedFiles(session)) {
      const fixture = artifacts[relPath];
      if (typeof fixture !== 'string') continue;
      const current = session.files[relPath]?.content;
      if (current !== fixture) {
        this.writeWorkspaceFile(session, relPath, fixture, 'engine', 'scenario_fixture');
      } else {
        const fullPath = path.join(session.workspaceDir, relPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, fixture, 'utf8');
      }
    }
  }

  writeWorkspaceFile(session, relPath, content, authorAgent, source = 'unspecified') {
    const safeRel = relPath.replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
    if (isProtectedScenarioFile(session, safeRel) && authorAgent !== 'engine') {
      this.recordRejectedProtectedWrite(session, safeRel, content, authorAgent);
      return null;
    }
    const fullPath = path.join(session.workspaceDir, safeRel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const text = String(content);
    fs.writeFileSync(fullPath, text, 'utf8');

    if (!session.fileHistory) session.fileHistory = {};
    if (!session.reworkDiffs) session.reworkDiffs = [];

    const previous = session.files[safeRel];
    const history = session.fileHistory[safeRel] || (session.fileHistory[safeRel] = []);
    const updatedAt = new Date().toISOString();
    const pass = (session.reworkCycles || 0) > 0 ? session.reworkCycles + 1 : 1;
    history.push({
      revision: history.length + 1,
      author: authorAgent,
      source,
      reworkAttempt: session._captureReworkDiff ? session.reworkCycles || 0 : 0,
      updatedAt,
      bytes: Buffer.byteLength(text, 'utf8'),
      pass,
      content: text,
    });

    let diffMeta = null;
    if (session._captureReworkDiff && typeof previous?.content === 'string' && previous.content !== text) {
      diffMeta = buildReworkDiff({
        filePath: safeRel,
        before: previous.content,
        after: text,
        author: authorAgent,
        source,
        reworkAttempt: session.reworkCycles || 1,
      });
      session.reworkDiffs.push(diffMeta);
    }

    session.files[safeRel] = {
      path: safeRel,
      size: Buffer.byteLength(text, 'utf8'),
      author: authorAgent,
      source,
      updatedAt,
      content: text,
      diff: diffMeta ? diffMeta.diff : (previous?.diff || null),
      beforeSnippet: diffMeta ? diffMeta.beforeSnippet : (previous?.beforeSnippet || null),
      afterSnippet: diffMeta ? diffMeta.afterSnippet : (previous?.afterSnippet || null),
    };

    this.emitEvent(session, 'file_written', {
      path: safeRel,
      author: authorAgent,
      source,
      size: session.files[safeRel].size,
      revision: history.length,
      reworkDiff: Boolean(diffMeta),
    });
    return fullPath;
  }

  runWorkspaceTests(session, label = {}) {
    this.enforceScenarioGradingTests(session);
    const startMs = Date.now();
    const results = {
      run: (session.verificationRuns || []).length + 1,
      pass: label.pass || (session.reworkCycles || 0) + 1,
      phase: label.phase || 'verify',
      reworkAttempt: label.reworkAttempt || 0,
      candidate: label.candidate || null,
      passed: true,
      checks: [],
      passedCount: 0,
      failedCount: 0,
      durationMs: 0,
      stdout: '',
      stderr: '',
      executedAt: new Date().toISOString(),
    };

    // 1. Syntax check all .js files via node --check
    for (const relPath of Object.keys(session.files)) {
      if (relPath.endsWith('.js')) {
        const fullPath = path.join(session.workspaceDir, relPath);
        try {
          execSync(`node --check "${fullPath}"`, { cwd: session.workspaceDir, stdio: 'pipe', timeout: 8000 });
          results.checks.push({ name: `syntax:${relPath}`, passed: true, detail: 'Valid JS syntax' });
        } catch (err) {
          results.passed = false;
          const errMsg = (err.stderr ? err.stderr.toString() : err.message).slice(0, 400);
          results.checks.push({ name: `syntax:${relPath}`, passed: false, detail: errMsg });
          results.stderr += `\n[Syntax Error in ${relPath}]: ${errMsg}`;
        }
      }
    }

    // 2. Run test.js if present
    const testPath = path.join(session.workspaceDir, 'test.js');
    if (fs.existsSync(testPath)) {
      try {
        const out = execSync(`node "${testPath}"`, {
          cwd: session.workspaceDir,
          stdio: 'pipe',
          timeout: 12000,
        });
        const stdoutStr = out.toString();
        results.stdout += stdoutStr;
        const passMatches = (stdoutStr.match(/\[PASS\]/gi) || []).length;
        results.checks.push({
          name: 'runtime:test.js',
          passed: true,
          assertionsPassed: passMatches || 1,
          detail: stdoutStr.trim().slice(0, 300),
        });
      } catch (err) {
        results.passed = false;
        const errOut = (err.stdout ? err.stdout.toString() : '') + '\n' + (err.stderr ? err.stderr.toString() : err.message);
        results.stderr += errOut;
        results.checks.push({ name: 'runtime:test.js', passed: false, detail: errOut.trim().slice(0, 400) });
      }
    } else {
      results.passed = false;
      results.checks.push({ name: 'runtime:test.js', passed: false, detail: 'Missing test.js in workspace' });
    }

    // 3. Verify required UI & contract files exist
    const hasHtml = Boolean(session.files['index.html']);
    results.checks.push({
      name: 'artifact:index.html',
      passed: hasHtml,
      detail: hasHtml ? `index.html present (${session.files['index.html'].size} bytes)` : 'Missing index.html',
    });
    if (!hasHtml) results.passed = false;

    results.passedCount = results.checks.filter((c) => c.passed).length;
    results.failedCount = results.checks.filter((c) => !c.passed).length;
    results.durationMs = Date.now() - startMs;

    session.verificationRuns.push(results);
    this.emitEvent(session, 'verification_run', { results });
    return results;
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

  saveSessionSnapshot(session) {
    if (!session || !session.workspaceDir) return;
    const dirName = path.basename(session.workspaceDir);
    if (session.golden || session.readOnly || dirName.startsWith('golden-')) return;
    try {
      const serialized = this.serializeSession(session);
      fs.writeFileSync(
        path.join(session.workspaceDir, '.session.json'),
        JSON.stringify(serialized, null, 2),
        'utf8'
      );
      if (session.benchmark) {
        fs.writeFileSync(
          path.join(session.workspaceDir, 'benchmark.json'),
          JSON.stringify(session.benchmark, null, 2),
          'utf8'
        );
      }
    } catch (_) {}
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

      const archPrompt = `User Software Request: "${session.prompt}"

Design a complete, self-contained, zero-external-dependency web + Node.js software solution that fulfills this request and can be verified immediately with \`node test.js\` and previewed in a browser via \`index.html\`.

Return ONLY a valid JSON object inside a \`\`\`json code block with the following exact schema:
{
  "projectTitle": "Short title",
  "briefMd": "Full markdown content for brief.md covering Problem, Target Users, Core Features, and Architecture",
  "runbookMd": "Full markdown content for runbook.md covering File Layout (index.html, app.js, test.js), Module Contracts, and Do NOT rules",
  "kanbanTasks": [
    {
      "id": "TASK-1",
      "title": "Core Logic & Interactive UI Implementation",
      "assignee": "@builder",
      "description": "Implement app.js (exports core functions for Node tests AND attaches to window in browser) and index.html (sleek interactive dark-mode UI).",
      "acceptanceCriteria": ["app.js works in both Node.js CommonJS and browser DOM", "index.html provides interactive UI", "test.js runs automated assertions"]
    },
    {
      "id": "TASK-2",
      "title": "Runtime Verification & Edge-Case Audit",
      "assignee": "@verifier",
      "parentId": "TASK-1",
      "description": "Execute node test.js, verify all core functions and edge cases, and audit UI/code quality.",
      "acceptanceCriteria": ["node test.js exits 0", "All edge cases verified"]
    },
    {
      "id": "TASK-3",
      "title": "Documentation & Launch Synthesis",
      "assignee": "@lead",
      "parentId": "TASK-2",
      "description": "Produce README.md and LAUNCH_SUMMARY.md based on verified artifacts.",
      "acceptanceCriteria": ["Complete README.md with usage instructions"]
    }
  ],
  "messageToBuilder": "Direct bot-to-bot message to @builder (using @builder mention) explaining the architecture contract and handing off TASK-1.",
  "messageToVerifier": "Direct bot-to-bot message to @verifier (using @verifier mention) outlining what edge cases and invariants to test in TASK-2."
}`;

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
      const archDefault = {
        projectTitle: 'MuseSwarm Generated Application',
        briefMd: `# Project Brief\n\n**Request:** ${session.prompt}\n\n## Architecture\n- \`app.js\`: Isomorphic core engine (Node.js CommonJS export + browser \`window.AppCore\`).\n- \`index.html\`: Interactive modern UI dashboard.\n- \`test.js\`: Automated zero-dependency Node.js test suite using \`assert\`.`,
        runbookMd: `# Runbook\n\n## Files Required\n1. \`app.js\` — Core logic module exported via \`if (typeof module !== 'undefined') module.exports = ...\` and attached to \`window\`.\n2. \`index.html\` — Standalone interactive web app loading \`app.js\`.\n3. \`test.js\` — Node.js test suite that requires \`./app.js\`, runs assertions, and prints PASS.\n\n## Do NOT\n- Do NOT require external npm packages.\n- Do NOT leave placeholder TODOs.`,
        kanbanTasks: [
          {
            id: 'TASK-1',
            title: 'Implement Core Engine (app.js), UI (index.html), and Unit Tests (test.js)',
            assignee: '@builder',
            description: 'Build isomorphic app.js, interactive index.html, and comprehensive test.js.',
            acceptanceCriteria: ['Zero external dependencies', 'node test.js passes with 0 exit code'],
          },
          {
            id: 'TASK-2',
            title: 'Verify Runtime Tests & Audit Edge Cases',
            assignee: '@verifier',
            parentId: 'TASK-1',
            description: 'Inspect code and verify node test.js output.',
            acceptanceCriteria: ['All assertions pass'],
          },
          {
            id: 'TASK-3',
            title: 'Synthesize Release Package & Documentation',
            assignee: '@lead',
            parentId: 'TASK-2',
            description: 'Write README.md and final launch report.',
            acceptanceCriteria: ['Clear documentation'],
          },
        ],
        messageToBuilder: `@builder I have written brief.md and runbook.md for "${session.prompt}". Please implement app.js (compatible with both Node CommonJS and browser window), index.html, and test.js for TASK-1.`,
        messageToVerifier: `@verifier Once @builder completes TASK-1, run the test suite and audit app.js and index.html against our acceptance criteria.`,
      };
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

      const builderPromptFor = (tight) => `You are @builder executing TASK-1 for the project: "${session.prompt}".

Here is \`brief.md\` from @architect:
${(archPlan.briefMd || '').slice(0, tight ? 1200 : 4000)}

Here is \`runbook.md\` from @architect:
${(archPlan.runbookMd || '').slice(0, tight ? 1200 : 4000)}

Message from @architect:
"${archPlan.messageToBuilder}"

Write compact, complete files now. Do not deliberate${tight ? ' (your previous reply ran out of tokens while reasoning and returned no files)' : ''}: put tokens into file contents, not commentary.
CRITICAL RULES:
1. \`app.js\` MUST be pure JavaScript with ZERO external npm packages. Export for Node (\`module.exports\`) AND \`globalThis.AppCore\`.
2. \`index.html\` MUST be a short dark-mode page that loads \`<script src="app.js"></script>\` (keep it under 80 lines).
${session.scenarioId
    ? `3. Do NOT emit \`test.js\` (or any other test file). Grading tests are engine-owned and read-only; a test.js write is rejected and does not change the score.`
    : `3. \`test.js\` MUST require \`./app.js\`, use Node \`assert\`, print \`[PASS]\` lines, and exit 0. At least 5 tests.`}
4. Messages to other bots: one sentence each. No long comments in source.

Return ONLY one strict JSON object (no prose, no markdown fences). Every file's full source goes in a JSON string, with newlines escaped as \\n and double quotes escaped as \\". Schema:
{
  "messageToArchitect": "One sentence to @architect.",
  "messageToVerifier": "One sentence to @verifier.",
  "files": [
    { "path": "app.js", "content": "<full source of app.js>" },
    { "path": "index.html", "content": "<full source of index.html>" }${session.scenarioId ? '' : `,
    { "path": "test.js", "content": "<full source of test.js>" }`}
  ]
}`;

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
        const fixPromptFor = (tight) => `The sandbox test runner reported an error for "${session.prompt}" (Rework Attempt #${reworkAttempt})${tight ? ' (your previous reply ran out of tokens while reasoning and returned no content)' : ''}.

Failing test output:
${failOutFull.slice(0, tight ? 600 : 1200)}

Writable file (patch ONLY this):
${writableBlock}
${readOnlyTests.length ? `--- test.js (read-only) ---
test.js is engine-owned grading and must not be edited.
` : ''}
Patch ONLY ${targets.join(', ') || 'domain.js'}. Do not emit test.js or app.js.
Return ONLY one strict JSON object (no prose, no markdown fences). Schema:
{
  "messageToVerifier": "Root cause and fix, addressed to @verifier",
  "files": [ { "path": "${targets[0] || 'domain.js'}", "content": "<full patched source>" } ]
}`;
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

      const verifierPrompt = `You are @verifier auditing the completed code and sandbox test execution for "${session.prompt}".

Sandbox Execution Result:
- Passed: ${testRun.passed} (${testRun.passedCount}/${testRun.checks.length} checks green)
- Checks: ${JSON.stringify(testRun.checks)}
- Stdout:
${testRun.stdout}

Automated Rubric Baseline: ${JSON.stringify(rubricEval)}

Files in workspace: ${Object.keys(session.files).join(', ')}

app.js preview:
${(session.files['app.js']?.content || '').slice(0, 2500)}

Return ONLY a valid JSON object inside a \`\`\`json code block:
{
  "verdict": "VERIFIED_PASS",
  "qualityScore": 98,
  "rubric": {
    "correctness": 25,
    "testCoverage": 24,
    "architectureAdherence": 25,
    "uiCompleteness": 24
  },
  "messageToBuilder": "Constructive peer review message to @builder citing specific strengths in app.js and test.js.",
  "messageToLead": "Handoff message to @lead (with @lead mention) confirming all checks passed and summarizing verified capabilities."
}`;

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

      const leadPromptFor = (tight) => `You are @lead wrapping up the MuseSwarm build for "${session.prompt}".
Verified files: ${Object.keys(session.files).join(', ')}
Rubric Score: ${session.rubricEvaluation.qualityScore}/100
Test output:
${(testRun.stdout || '').slice(0, tight ? 600 : 2000)}

Write a short, structured release note. Do not deliberate: answer directly${tight ? ' (your previous reply ran out of tokens while reasoning and returned no content)' : ''}.
Return ONLY one strict JSON object (no prose, no markdown fences) with newlines escaped as \\n:
{
  "readmeMd": "README.md, at most ${tight ? 25 : 60} lines: title, one-paragraph summary, ## Features (bullets), ## Files (one bullet per file), ## Run (node test.js, open index.html)",
  "finalBroadcast": "One or two sentences to @all summarizing what @architect, @builder, @verifier, and @lead accomplished."
}`;

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
      const leadDefault = {
        readmeMd: `# ${archPlan.projectTitle || 'MuseSwarm Generated App'}\n\nBuilt autonomously by **MuseSwarm** (\`@architect\`, \`@builder\`, \`@verifier\`, \`@lead\`) powered by Meta's \`Muse Spark Open\` (\`meta-models/muse-spark-open-1026\`) on Baseten.\n\n## Run Tests\n\`\`\`bash\nnode test.js\n\`\`\`\n\n## Open Web App\nOpen \`index.html\` in your browser or via the MuseSwarm Live Preview drawer.`,
        finalBroadcast: `@all Release package synthesized! All Kanban tasks (TASK-1, TASK-2, TASK-3) are complete, verified by @verifier (${session.rubricEvaluation.qualityScore}/100), and documented in README.md.`,
      };

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

  writeFallbackArtifacts(session) {
    if (session._cleanArtifacts) {
      this.restoreScenarioCodeFixtures(session, 'engine_fallback', { force: true });
      return;
    }
    const appJs = `// Generated by MuseSwarm (@builder) — Isomorphic Core Engine
class TaskPriorityEngine {
  constructor() {
    this.items = [];
  }

  addItem({ title, impact = 5, urgency = 5, effort = 3, slaMinutes = 60, elapsedMinutes = 0, owner = '@builder' }) {
    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new Error('Title is required');
    }
    const cleanImpact = Math.max(1, Math.min(10, Number(impact) || 5));
    const cleanUrgency = Math.max(1, Math.min(10, Number(urgency) || 5));
    const cleanEffort = Math.max(1, Math.min(10, Number(effort) || 3));
    const cleanSla = Math.max(1, Number(slaMinutes) || 60);
    const cleanElapsed = Math.max(0, Number(elapsedMinutes) || 0);
    const slaBreached = cleanElapsed >= cleanSla;
    const slaBoost = slaBreached ? 2.5 : 0;
    const score = Number(((((cleanImpact * 1.6) + (cleanUrgency * 1.4)) / Math.sqrt(cleanEffort)) + slaBoost).toFixed(2));
    const item = {
      id: 'item-' + (this.items.length + 1),
      title: title.trim(),
      impact: cleanImpact,
      urgency: cleanUrgency,
      effort: cleanEffort,
      slaMinutes: cleanSla,
      elapsedMinutes: cleanElapsed,
      slaBreached,
      owner,
      score,
      status: 'open',
    };
    this.items.push(item);
    return item;
  }

  getRankedItems() {
    return [...this.items].sort((a, b) => b.score - a.score);
  }

  getSlaBreaches() {
    return this.items.filter((i) => i.status !== 'done' && i.slaBreached);
  }

  completeItem(id) {
    const found = this.items.find((i) => i.id === id);
    if (!found) throw new Error('Item not found: ' + id);
    found.status = 'done';
    return found;
  }

  getSummary() {
    const total = this.items.length;
    const done = this.items.filter((i) => i.status === 'done').length;
    const breaches = this.getSlaBreaches().length;
    const top = this.getRankedItems()[0] || null;
    return { total, done, open: total - done, slaBreaches: breaches, topPriority: top ? top.title : null };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TaskPriorityEngine };
}
if (typeof globalThis !== 'undefined') {
  globalThis.AppCore = { TaskPriorityEngine };
}
`;

    const testJs = `const assert = require('assert');
const { TaskPriorityEngine } = require('./app.js');

console.log('Running MuseSwarm Verification Suite...');

const engine = new TaskPriorityEngine();
const t1 = engine.addItem({ title: 'Wire Baseten Muse Spark Open API', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45 });
const t2 = engine.addItem({ title: 'Polish Dark Mode Theme', impact: 6, urgency: 5, effort: 4, slaMinutes: 120, elapsedMinutes: 20 });
const t3 = engine.addItem({ title: 'Add Kanban Session Bus', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 15 });

assert.strictEqual(engine.items.length, 3, 'Should have 3 items');
console.log('[PASS] Test 1: Added items and calculated priority scores');

const ranked = engine.getRankedItems();
assert.strictEqual(ranked[0].id, t1.id, 'Highest impact/urgency item with SLA boost should rank first');
console.log('[PASS] Test 2: Priority ranking order verified (top score=' + ranked[0].score + ')');

const breaches = engine.getSlaBreaches();
assert.strictEqual(breaches.length, 1, 'Should detect 1 active SLA breach');
assert.strictEqual(breaches[0].id, t1.id, 'SLA breached item should match t1');
console.log('[PASS] Test 3: SLA breach detection verified');

engine.completeItem(t2.id);
const summary = engine.getSummary();
assert.strictEqual(summary.done, 1, 'Should record 1 completed item');
assert.strictEqual(summary.open, 2, 'Should record 2 open items');
console.log('[PASS] Test 4: Status transition & summary metrics verified');

assert.throws(() => engine.addItem({ title: '   ' }), /Title is required/, 'Empty title must throw');
assert.throws(() => engine.completeItem('non-existent'), /Item not found/, 'Unknown ID must throw');
console.log('[PASS] Test 5: Input validation & error handling verified');

console.log('ALL 5 TESTS PASSED SUCCESSFULLY.');
`;

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>MuseSwarm Priority Studio</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 24px; }
    .card { max-width: 760px; margin: 0 auto; background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; }
    h1 { margin-top: 0; font-size: 1.4rem; color: #818cf8; }
    .row { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
    input { background: #1f2937; border: 1px solid #374151; color: #fff; padding: 8px 12px; border-radius: 6px; }
    button { background: #6366f1; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .item { display: flex; justify-content: space-between; padding: 10px 12px; background: #1e293b; border-radius: 8px; margin-bottom: 8px; align-items: center; }
    .score { color: #34d399; font-weight: 700; }
    .sla-badge { background: rgba(239,68,68,0.2); color: #f87171; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; margin-left: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>MuseSwarm Co-Built App: Engineering Priority Studio</h1>
    <div class="row">
      <input id="title" placeholder="Task title..." style="flex:1" />
      <input id="impact" type="number" min="1" max="10" value="8" style="width:70px" title="Impact" />
      <input id="urgency" type="number" min="1" max="10" value="8" style="width:70px" title="Urgency" />
      <input id="effort" type="number" min="1" max="10" value="3" style="width:70px" title="Effort" />
      <button onclick="addNew()">Add Task</button>
    </div>
    <div id="list"></div>
  </div>
  <script src="app.js"></script>
  <script>
    const engine = new globalThis.AppCore.TaskPriorityEngine();
    engine.addItem({ title: 'Multi-Agent Session Bus', impact: 10, urgency: 9, effort: 2, slaMinutes: 30, elapsedMinutes: 45 });
    engine.addItem({ title: 'Baseten 2M TPM Telemetry Gauge', impact: 9, urgency: 8, effort: 3, slaMinutes: 60, elapsedMinutes: 20 });
    function render() {
      const list = document.getElementById('list');
      list.innerHTML = engine.getRankedItems().map(i =>
        '<div class="item"><span>' + i.title + ' <small>(' + i.status + ')</small>' +
        (i.slaBreached ? '<span class="sla-badge">SLA BREACH</span>' : '') +
        '</span><span class="score">Score: ' + i.score + '</span></div>'
      ).join('');
    }
    function addNew() {
      const t = document.getElementById('title').value;
      if (!t) return;
      engine.addItem({
        title: t,
        impact: Number(document.getElementById('impact').value),
        urgency: Number(document.getElementById('urgency').value),
        effort: Number(document.getElementById('effort').value),
      });
      document.getElementById('title').value = '';
      render();
    }
    render();
  </script>
</body>
</html>`;

    this.writeWorkspaceFile(session, 'app.js', appJs, 'engine', 'engine_fallback');
    if (!isProtectedScenarioFile(session, 'test.js')) {
      this.writeWorkspaceFile(session, 'test.js', testJs, 'engine', 'engine_fallback');
    }
    this.writeWorkspaceFile(session, 'index.html', indexHtml, 'engine', 'engine_fallback');
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

module.exports = {
  MuseSwarmEngine,
  AGENT_PROFILES,
  extractJsonBlock,
  SCENARIO_PRESETS,
  resolveScenarioId,
  serializeScenarios,
  buildReworkDiff,
};
