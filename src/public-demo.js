'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

const GOLDEN_PREFIX = 'golden-';

function isGoldenWorkspaceDir(dirName) {
  return String(dirName || '').startsWith(GOLDEN_PREFIX);
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
  isGoldenWorkspaceDir,
  listGoldenWorkspaceDirs,
  createRateLimiter,
  createConcurrencyGate,
  clientKey,
  annotateGoldenSession,
  isGoldenSession,
  goldenCatalog,
  buildReplayEvents,
  replayEventsToSse,
};
