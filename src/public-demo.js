'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

const GOLDEN_PREFIX = 'golden-';
const COMMITTED_REFERENCE_WORKSPACES = Object.freeze(['sprint-priority-engine-8z24']);
const MID_RUN_STATUSES = new Set(['initialized', 'running', 'in_progress']);

function isGoldenWorkspaceDir(dirName) {
  return String(dirName || '').startsWith(GOLDEN_PREFIX);
}

function isProtectedWorkspaceDir(dirName) {
  const name = String(dirName || '');
  if (!name || name === '.' || name === '..') return true;
  if (name === 'golden' || isGoldenWorkspaceDir(name)) return true;
  return COMMITTED_REFERENCE_WORKSPACES.includes(name);
}

function isMidRunSession(session) {
  if (!session) return false;
  return MID_RUN_STATUSES.has(String(session.status || ''));
}

function resolveInsideWorkspaces(dir, rootDir = CONFIG.workspacesDir) {
  const root = path.resolve(rootDir);
  const target = path.resolve(dir);
  const rel = path.relative(root, target);
  if (!rel || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((part) => part === '..')) return null;
  // Direct children of workspaces/ only — never recurse or escape.
  if (rel.split(path.sep).length !== 1) return null;
  return target;
}

function safeRemoveWorkspaceDir(dir, rootDir = CONFIG.workspacesDir) {
  const target = resolveInsideWorkspaces(dir, rootDir);
  if (!target) return false;
  if (isProtectedWorkspaceDir(path.basename(target))) return false;
  let rootReal;
  let targetReal;
  try {
    rootReal = fs.realpathSync(rootDir);
    targetReal = fs.existsSync(target) ? fs.realpathSync(target) : target;
  } catch (_) {
    return false;
  }
  const rel = path.relative(rootReal, targetReal);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 1) return false;
  if (isProtectedWorkspaceDir(path.basename(targetReal))) return false;
  try {
    fs.rmSync(targetReal, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

function sessionForWorkspaceDir(engine, absDir) {
  if (!engine || !engine.sessions) return null;
  const resolved = path.resolve(absDir);
  for (const session of engine.sessions.values()) {
    if (!session.workspaceDir) continue;
    if (path.resolve(session.workspaceDir) === resolved) return session;
  }
  return null;
}

function workspaceAgeMs(absDir, session, now) {
  if (session && session.createdAt) {
    const t = Date.parse(session.createdAt);
    if (Number.isFinite(t)) return Math.max(0, now - t);
  }
  try {
    const st = fs.statSync(absDir);
    const stamp = Number(st.mtimeMs || st.ctimeMs || 0);
    return Number.isFinite(stamp) ? Math.max(0, now - stamp) : 0;
  } catch (_) {
    return 0;
  }
}

function listEphemeralWorkspaceDirs(rootDir = CONFIG.workspacesDir, engine = null) {
  if (!fs.existsSync(rootDir)) return [];
  const now = Date.now();
  const entries = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (isProtectedWorkspaceDir(entry.name)) continue;
    const absDir = path.join(rootDir, entry.name);
    if (!resolveInsideWorkspaces(absDir, rootDir)) continue;
    const session = sessionForWorkspaceDir(engine, absDir);
    if (session && (isGoldenSession(session) || session.readOnly || session.golden)) continue;
    entries.push({
      name: entry.name,
      dir: absDir,
      session,
      midRun: isMidRunSession(session),
      ageMs: workspaceAgeMs(absDir, session, now),
    });
  }
  return entries;
}

function prunePublicDemoWorkspaces(engine, options = {}) {
  const rootDir = options.rootDir || CONFIG.workspacesDir;
  const maxWorkspaces = Number(options.maxWorkspaces) > 0 ? Number(options.maxWorkspaces) : CONFIG.publicDemoMaxWorkspaces;
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : CONFIG.publicDemoWorkspaceTtlMs;
  const reserve = Math.max(0, Number(options.reserve) || 0);
  const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
  const pruned = [];

  const ephemeral = listEphemeralWorkspaceDirs(rootDir, engine).map((row) => ({
    ...row,
    ageMs: workspaceAgeMs(row.dir, row.session, now),
  }));

  const tryPrune = (row, reason) => {
    if (row.midRun) return false;
    if (row.session && isMidRunSession(row.session)) return false;
    if (!safeRemoveWorkspaceDir(row.dir, rootDir)) return false;
    if (row.session && engine && engine.sessions) {
      engine.sessions.delete(row.session.id);
      if (engine.activeSessionId === row.session.id) {
        const next = Array.from(engine.sessions.values()).find((s) => isGoldenSession(s)) || Array.from(engine.sessions.values())[0];
        engine.activeSessionId = next ? next.id : null;
      }
    }
    pruned.push({ dir: row.dir, name: row.name, sessionId: row.session ? row.session.id : null, reason });
    row.removed = true;
    return true;
  };

  if (ttlMs > 0) {
    for (const row of ephemeral) {
      if (row.ageMs >= ttlMs) tryPrune(row, 'ttl');
    }
  }

  const remaining = ephemeral.filter((row) => !row.removed);
  const target = Math.max(0, maxWorkspaces - reserve);
  const over = remaining.length - target;
  if (over > 0) {
    const pruneable = remaining
      .filter((row) => !row.midRun)
      .sort((a, b) => a.ageMs - b.ageMs || String(a.name).localeCompare(b.name))
      .reverse(); // oldest first (largest ageMs)
    let need = over;
    for (const row of pruneable) {
      if (need <= 0) break;
      if (tryPrune(row, 'cap')) need -= 1;
    }
  }

  return {
    pruned,
    remaining: listEphemeralWorkspaceDirs(rootDir, engine).length,
  };
}

function createDemoWorkspaceGc(engine, options = {}) {
  let prunedCount = 0;
  let timer = null;
  const sweep = (sweepOptions = {}) => {
    const result = prunePublicDemoWorkspaces(engine, {
      rootDir: options.rootDir,
      maxWorkspaces: options.maxWorkspaces,
      ttlMs: options.ttlMs,
      reserve: sweepOptions.reserve,
      now: sweepOptions.now,
    });
    prunedCount += result.pruned.length;
    return result;
  };
  return {
    sweep,
    get pruned() {
      return prunedCount;
    },
    startPeriodic(ms) {
      const every = Number(ms) > 0 ? Number(ms) : (options.sweepMs || CONFIG.publicDemoSweepMs);
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        try {
          sweep({ reserve: 0 });
        } catch (_) {}
      }, every);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function listGoldenWorkspaceDirs(rootDir = CONFIG.workspacesDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isGoldenWorkspaceDir(entry.name))
    .map((entry) => path.join(rootDir, entry.name))
    .sort();
}

function createRateLimiter({ limit, windowMs } = {}) {
  const max = Number(limit) > 0 ? Number(limit) : CONFIG.publicDemoPostLimit;
  const window = Number(windowMs) > 0 ? Number(windowMs) : CONFIG.publicDemoPostWindowMs;
  const hits = new Map();
  return {
    allow(key) {
      const now = Date.now();
      const bucket = (hits.get(key) || []).filter((t) => now - t < window);
      if (bucket.length >= max) {
        hits.set(key, bucket);
        return false;
      }
      bucket.push(now);
      hits.set(key, bucket);
      return true;
    },
    remaining(key) {
      const now = Date.now();
      const bucket = (hits.get(key) || []).filter((t) => now - t < window);
      return Math.max(0, max - bucket.length);
    },
  };
}

function createConcurrencyGate(max = CONFIG.publicDemoMaxConcurrent) {
  let active = 0;
  const limit = Number(max) > 0 ? Number(max) : 2;
  return {
    tryEnter() {
      if (active >= limit) return false;
      active += 1;
      return true;
    },
    leave() {
      active = Math.max(0, active - 1);
    },
    get active() {
      return active;
    },
  };
}

function clientKey(req) {
  return String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || req.socket?.remoteAddress || 'local')
    .split(',')[0]
    .trim();
}

function annotateGoldenSession(session, workspaceDir) {
  if (!session) return session;
  session.golden = true;
  session.readOnly = true;
  session.workspaceDir = workspaceDir;
  if (session.telemetry && typeof session.telemetry === 'object') {
    session.telemetry = { ...session.telemetry, hasApiKey: false };
  }
  return session;
}

function isGoldenSession(session) {
  if (!session) return false;
  if (session.golden || session.readOnly) return true;
  const dir = session.workspaceDir ? path.basename(session.workspaceDir) : '';
  return isGoldenWorkspaceDir(dir);
}

function goldenCatalog(engine) {
  return Array.from(engine.sessions.values())
    .filter(isGoldenSession)
    .map((session) => ({
      sessionId: session.id,
      slug: session.slug,
      scenarioId: session.scenarioId || null,
      healedBy: session.healedBy || (session.reworkSummary || []).map((c) => c.healedBy),
      verdict: session.rubricEvaluation?.verdict || session.benchmark?.rubric?.verdict || null,
      qualityScore: session.rubricEvaluation?.qualityScore || session.benchmark?.rubric?.qualityScore || null,
      status: session.status,
      golden: true,
      readOnly: true,
    }))
    .sort((a, b) => String(a.scenarioId).localeCompare(String(b.scenarioId)));
}

function ts(value, fallback) {
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildReplayEvents(session) {
  const sessionId = session.id;
  const events = [];
  let seq = ts(session.createdAt, Date.now());

  events.push({
    eventType: 'session_created',
    sessionId,
    timestamp: session.createdAt,
    _t: seq,
    scenarioId: session.scenarioId || null,
    golden: true,
  });

  for (const reply of session.modelReplies || []) {
    const agent = String(reply.agent || '').replace(/^@/, '') || 'builder';
    const t = ts(reply.recordedAt, seq + 1);
    seq = Math.max(seq + 1, t);
    events.push({
      eventType: 'agent_active',
      sessionId,
      timestamp: reply.recordedAt,
      _t: t,
      agentId: agent,
      phase: reply.phase,
    });
    events.push({
      eventType: 'llm_complete',
      sessionId,
      timestamp: reply.recordedAt,
      _t: t + 1,
      agentId: agent,
      simulated: reply.simulated === true,
      finishReason: reply.finishReason,
      content: reply.content,
      reasoningContent: reply.reasoningContent,
      usage: reply.usage,
      latencyMs: reply.latencyMs,
      phase: reply.phase,
    });
  }

  for (const [relPath, history] of Object.entries(session.fileHistory || {})) {
    for (const snap of history || []) {
      const t = ts(snap.updatedAt, seq + 1);
      seq = Math.max(seq + 1, t);
      events.push({
        eventType: snap.rejected ? 'file_write_rejected' : 'file_written',
        sessionId,
        timestamp: snap.updatedAt,
        _t: t,
        path: relPath,
        author: snap.author,
        source: snap.source,
        rejected: Boolean(snap.rejected),
        bytes: snap.bytes,
        revision: snap.revision,
      });
    }
  }

  for (const msg of session.messages || []) {
    const t = ts(msg.timestamp, seq + 1);
    seq = Math.max(seq + 1, t);
    events.push({
      eventType: 'bot_message',
      sessionId,
      timestamp: msg.timestamp,
      _t: t,
      from: msg.from,
      to: msg.to,
      delivery: msg.delivery,
      content: msg.content,
      metadata: msg.metadata,
    });
  }

  for (const run of session.verificationRuns || []) {
    const t = ts(run.executedAt, seq + 1);
    seq = Math.max(seq + 1, t);
    events.push({
      eventType: 'verification_run',
      sessionId,
      timestamp: run.executedAt,
      _t: t,
      results: run,
    });
  }

  events.push({
    eventType: 'session_completed',
    sessionId,
    timestamp: session.completedAt || new Date().toISOString(),
    _t: ts(session.completedAt, seq + 10),
    golden: true,
    healedBy: session.healedBy || (session.reworkSummary || []).map((c) => c.healedBy),
    rubric: session.rubricEvaluation || null,
  });

  events.sort((a, b) => a._t - b._t || String(a.eventType).localeCompare(b.eventType));
  return events.map(({ _t, ...rest }) => rest);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function replayEventsToSse(res, events, { minMs = CONFIG.sseReplayMinMs, maxMs = CONFIG.sseReplayMaxMs } = {}) {
  let last = null;
  for (const event of events) {
    const now = Date.parse(event.timestamp);
    if (minMs > 0 && last != null && Number.isFinite(now)) {
      const wait = Math.min(maxMs, Math.max(minMs, Math.round((now - last) / 20)));
      if (wait > 0) await sleep(wait);
    }
    if (Number.isFinite(now)) last = now;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) {
      return;
    }
  }
}

module.exports = {
  GOLDEN_PREFIX,
  COMMITTED_REFERENCE_WORKSPACES,
  isGoldenWorkspaceDir,
  isProtectedWorkspaceDir,
  isMidRunSession,
  listGoldenWorkspaceDirs,
  listEphemeralWorkspaceDirs,
  safeRemoveWorkspaceDir,
  prunePublicDemoWorkspaces,
  createDemoWorkspaceGc,
  createRateLimiter,
  createConcurrencyGate,
  clientKey,
  annotateGoldenSession,
  isGoldenSession,
  goldenCatalog,
  buildReplayEvents,
  replayEventsToSse,
};
