const http = require('http');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');
const { executeToolCall } = require('./mcp-server');
const { MuseSwarmEngine, AGENT_PROFILES, SCENARIO_PRESETS, serializeScenarios } = require('./swarm-engine');
const {
  annotateGoldenSession,
  isGoldenWorkspaceDir,
  goldenCatalog,
  createRateLimiter,
  createConcurrencyGate,
  clientKey,
  buildReplayEvents,
  replayEventsToSse,
} = require('./public-demo');

const engine = new MuseSwarmEngine(
  CONFIG.publicDemo ? { offline: true, allowOfflineFallback: true } : {}
);
const sseClients = new Set();
const demoRateLimiter = CONFIG.publicDemo
  ? createRateLimiter({ limit: CONFIG.publicDemoPostLimit, windowMs: CONFIG.publicDemoPostWindowMs })
  : null;
const sandboxGate = CONFIG.publicDemo ? createConcurrencyGate(CONFIG.publicDemoMaxConcurrent) : null;

function normalizeAgentId(rawAgent) {
  const cleaned = String(rawAgent || 'architect').trim().replace(/^@+/, '').toLowerCase();
  return AGENT_PROFILES[cleaned] ? cleaned : 'architect';
}

// Broadcast every engine event over SSE to all connected browser tabs
engine.on('event', (event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
});

// Load any existing workspace sessions from disk on startup
function loadExistingWorkspaces() {
  if (!fs.existsSync(CONFIG.workspacesDir)) return;
  const entries = fs.readdirSync(CONFIG.workspacesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const wsDir = path.join(CONFIG.workspacesDir, entry.name);
      const metaPath = path.join(wsDir, '.session.json');
      if (fs.existsSync(metaPath)) {
        try {
          const saved = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          const filesMap = {};
          for (const f of saved.files || []) {
            filesMap[f.path] = f;
          }
          saved.files = filesMap;
          saved.workspaceDir = wsDir;
          saved.parallelTasksRun = saved.parallelTasksRun || [];
          saved.verificationRuns = saved.verificationRuns || [];
          saved.messages = saved.messages || [];
          saved.kanban = saved.kanban || [];
          saved.reworkDiffs = saved.reworkDiffs || [];
          saved.fileHistory = saved.fileHistory || {};
          engine.sessions.set(saved.id, saved);
          engine.activeSessionId = saved.id;
          if (isGoldenWorkspaceDir(entry.name) || saved.golden || saved.readOnly) {
            annotateGoldenSession(saved, wsDir);
          }
        } catch (_) {}
      } else if (fs.existsSync(path.join(wsDir, 'app.js'))) {
        try {
          const id = `swarm-${entry.name.slice(-4)}`;
          const filesMap = {};
          for (const fname of fs.readdirSync(wsDir)) {
            const fpath = path.join(wsDir, fname);
            if (fs.statSync(fpath).isFile() && !fname.startsWith('.')) {
              const content = fs.readFileSync(fpath, 'utf8');
              filesMap[fname] = {
                path: fname,
                size: Buffer.byteLength(content, 'utf8'),
                author: fname === 'brief.md' || fname === 'runbook.md' ? '@architect' : (fname === 'README.md' ? '@lead' : '@builder'),
                updatedAt: fs.statSync(fpath).mtime.toISOString(),
                content,
              };
            }
          }
          const session = {
            id,
            slug: entry.name,
            prompt: 'Build a Real-Time Engineering Sprint & Incident Priority Engine',
            workspaceDir: wsDir,
            status: 'completed',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            agents: AGENT_PROFILES,
            messages: [],
            kanban: [],
            files: filesMap,
            verificationRuns: [],
            parallelTasksRun: [],
            reworkCycles: 0,
            reworkDiffs: [],
            fileHistory: {},
            ObserverAdvisories: [],
            telemetry: getEffectiveTelemetry(),
          };
          engine.sessions.set(id, session);
          if (!engine.activeSessionId) engine.activeSessionId = id;
        } catch (_) {}
      }
    }
  }
}

loadExistingWorkspaces();

function demoMode() {
  return CONFIG.publicDemo ? 'public-demo' : null;
}

function getEffectiveTelemetry() {
  const liveTel = engine.client.getTelemetry();
  if (CONFIG.publicDemo) {
    return { ...liveTel, hasApiKey: false, mode: 'public-demo' };
  }
  if (liveTel.totalCalls > 0) return liveTel;
  const active = engine.activeSessionId ? engine.sessions.get(engine.activeSessionId) : null;
  if (active && active.telemetry && active.telemetry.totalCalls > 0) {
    return {
      ...active.telemetry,
      hasApiKey: liveTel.hasApiKey || active.telemetry.hasApiKey,
      mode: liveTel.hasApiKey ? "live-baseten" : active.telemetry.mode,
    };
  }
  return liveTel;
}


// Save session snapshot whenever completed
engine.on('event', (ev) => {
  if (ev.eventType === 'session_completed' && ev.session) {
    const s = engine.sessions.get(ev.sessionId);
    if (s) {
      engine.saveSessionSnapshot(s);
    }
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function findSession(sessionId) {
  if (!sessionId) {
    return engine.activeSessionId ? engine.sessions.get(engine.activeSessionId) || null : null;
  }
  const decoded = decodeURIComponent(sessionId);
  return (
    engine.sessions.get(decoded) ||
    Array.from(engine.sessions.values()).find((s) => s.slug === decoded || s.id === decoded) ||
    null
  );
}

function sessionDiffPayload(session) {
  return {
    ok: true,
    sessionId: session.id,
    scenarioId: session.scenarioId || null,
    reworkCycles: session.reworkCycles || 0,
    reworkDiffs: session.reworkDiffs || [],
    fileHistory: session.fileHistory || {},
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'text/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (CONFIG.publicDemo && req.method === 'POST' && demoRateLimiter && !demoRateLimiter.allow(clientKey(req))) {
    res.setHeader('Retry-After', String(Math.ceil(CONFIG.publicDemoPostWindowMs / 1000)));
    return sendJson(res, 429, { ok: false, error: 'Rate limit exceeded', mode: 'public-demo' });
  }

  // SSE stream
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ eventType: 'connected', telemetry: getEffectiveTelemetry(), mode: demoMode() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    const replayId = url.searchParams.get('sessionId');
    if (CONFIG.publicDemo && replayId) {
      const replaySession = findSession(replayId);
      if (replaySession) {
        replayEventsToSse(res, buildReplayEvents(replaySession)).catch(() => {});
      }
    }
    return;
  }

  // Health & Benchmark Telemetry Endpoint
  if ((pathname === '/api/telemetry' || pathname === '/api/health') && req.method === 'GET') {
    const sessions = Array.from(engine.sessions.values());
    const benchmarks = sessions
      .map((s) => s.benchmark || (s.status === 'completed' ? engine.generateBenchmarkSummary(s) : null))
      .filter(Boolean);

    return sendJson(res, 200, {
      ok: true,
      status: 'healthy',
      mode: demoMode() || getEffectiveTelemetry().mode,
      uptimeSec: Math.round(process.uptime()),
      modelId: CONFIG.modelId,
      endpoint: CONFIG.basetenBaseUrl,
      telemetry: getEffectiveTelemetry(),
      sessionsCount: sessions.length,
      goldens: goldenCatalog(engine),
      benchmarks,
    });
  }

  // Status & Telemetry
  if (pathname === '/api/status' && req.method === 'GET') {
    const sessions = Array.from(engine.sessions.values()).map((s) => engine.serializeSession(s));
    return sendJson(res, 200, {
      ok: true,
      mode: demoMode() || getEffectiveTelemetry().mode,
      modelId: CONFIG.modelId,
      endpoint: CONFIG.basetenBaseUrl,
      agents: AGENT_PROFILES,
      telemetry: getEffectiveTelemetry(),
      sessions,
      goldens: goldenCatalog(engine),
      activeSessionId: engine.activeSessionId,
      scenarios: serializeScenarios(),
    });
  }

  if (pathname === '/api/scenarios' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      scenarios: serializeScenarios(),
    });
  }

  const sessionDiffMatch = pathname.match(/^\/api\/session\/([^/]+)\/diffs$/);
  if ((sessionDiffMatch || pathname === '/api/swarm/diffs') && req.method === 'GET') {
    const requestedId = sessionDiffMatch ? sessionDiffMatch[1] : url.searchParams.get('sessionId');
    const session = findSession(requestedId);
    if (!session) return sendJson(res, 404, { ok: false, error: 'Session not found' });
    return sendJson(res, 200, sessionDiffPayload(session));
  }

  if (pathname === '/api/mcp/invoke' && req.method === 'POST') {
    const started = Date.now();
    try {
      const body = await readJsonBody(req);
      const tool = body.tool || body.name;
      const args = body.arguments || body.args || {};
      if (!tool) return sendJson(res, 400, { ok: false, error: 'tool (or name) is required' });
      const outcome = await executeToolCall(tool, args, engine);
      const latencyMs = Date.now() - started;
      const rpcId = body.id !== undefined ? body.id : 1;
      if (outcome.error) {
        return sendJson(res, 200, {
          ok: false,
          tool,
          latencyMs,
          response: { jsonrpc: '2.0', id: rpcId, error: outcome.error },
        });
      }
      return sendJson(res, 200, {
        ok: outcome.result?.isError ? false : true,
        tool,
        latencyMs,
        response: { jsonrpc: '2.0', id: rpcId, result: outcome.result },
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message, latencyMs: Date.now() - started });
    }
  }

  // Trigger a new multi-agent swarm run (supports simulateBrokenFirstPass for self-heal rework demo)
  if ((pathname === '/api/swarm/run' || pathname === '/api/swarm/rework') && req.method === 'POST') {
    let gateHeld = false;
    try {
      const body = await readJsonBody(req);
      const scenarioId = body.scenarioId || body.scenario || null;
      const preset = SCENARIO_PRESETS.find((item) => item.id === scenarioId);
      const prompt = (
        body.prompt ||
        preset?.prompt ||
        (pathname === '/api/swarm/rework'
          ? 'Build a Real-Time Engineering Sprint & Incident Priority Engine with SLA breach detection and automated tests.'
          : '')
      ).trim();
      if (!prompt) {
        return sendJson(res, 400, { ok: false, error: 'Prompt is required' });
      }
      if (CONFIG.publicDemo && sandboxGate) {
        if (!sandboxGate.tryEnter()) {
          return sendJson(res, 503, { ok: false, error: 'Too many concurrent sandbox runs', mode: 'public-demo' });
        }
        gateHeld = true;
      }
      const simulateBrokenFirstPass =
        pathname === '/api/swarm/rework' || Boolean(body.simulateBrokenFirstPass || body.broken);
      const session = engine.createSession({
        prompt,
        projectName: body.projectName,
        simulateBrokenFirstPass,
        scenarioId,
      });

      const sync = body.sync === true || body.async === false;
      if (sync) {
        await engine.executeSwarm(session);
      } else {
        // Run asynchronously so client watches SSE events in real time
        gateHeld = false;
        engine.executeSwarm(session)
          .catch((err) => {
            console.error('Swarm run error:', err);
          })
          .finally(() => {
            if (CONFIG.publicDemo && sandboxGate) sandboxGate.leave();
          });
      }
      return sendJson(res, 200, {
        ok: true,
        simulateBrokenFirstPass,
        scenarioId: session.scenarioId,
        mode: demoMode() || undefined,
        session: engine.serializeSession(session),
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    } finally {
      if (gateHeld && sandboxGate) sandboxGate.leave();
    }
  }

  // Direct chat/ping to a single specialist bot (accepts 'architect' or '@architect')
  if (pathname === '/api/swarm/message' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const agentId = normalizeAgentId(body.agent || body.to || 'architect');
      const message = (body.message || body.text || '').trim();
      if (!message) {
        return sendJson(res, 400, { ok: false, error: 'Message is required' });
      }
      const sessionId = body.sessionId || engine.activeSessionId;
      const profile = AGENT_PROFILES[agentId] || AGENT_PROFILES.architect;

      const llmRes = await engine.client.chatCompletion({
        agentId,
        maxTokens: 1500,
        messages: [
          {
            role: 'system',
            content: `You are ${profile.handle} (${profile.name} — ${profile.role}) in a MuseSwarm multi-agent team powered by Meta's Muse Spark Open on Baseten. Respond concisely and constructively.`,
          },
          { role: 'user', content: message },
        ],
      });

      const session = sessionId ? engine.sessions.get(sessionId) : null;
      let postedMsg = null;
      if (session) {
        engine.postBotMessage(session, {
          from: '@user',
          to: profile.handle,
          delivery: 'steer',
          content: message,
          metadata: { phase: 'user_steer', tokens: 0, latencyMs: 0 },
        });
        postedMsg = engine.postBotMessage(session, {
          from: profile.handle,
          to: '@all',
          delivery: 'notify',
          content: llmRes.content,
          reasoning: llmRes.reasoningContent,
          metadata: {
            phase: 'agent_steer_reply',
            tokens: llmRes.usage?.totalTokens || 0,
            reasoningTokens: llmRes.usage?.reasoningTokens || 0,
            latencyMs: llmRes.latencyMs || 0,
          },
        });
      }

      return sendJson(res, 200, {
        ok: true,
        agent: profile,
        reply: llmRes.content,
        reasoning: llmRes.reasoningContent,
        usage: llmRes.usage,
        latencyMs: llmRes.latencyMs,
        message: postedMsg,
        telemetry: getEffectiveTelemetry(),
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Serve generated workspace files for live browser preview: /preview/<sessionId>/<file>
  if (pathname.startsWith('/preview/')) {
    const parts = pathname.replace(/^\/preview\//, '').split('/');
    const sessionId = parts[0];
    const relFile = parts.slice(1).join('/') || 'index.html';
    let decodedId = sessionId;
    try {
      decodedId = decodeURIComponent(sessionId);
    } catch (_) {}
    const session =
      engine.sessions.get(decodedId) ||
      Array.from(engine.sessions.values()).find((s) => {
        if (s.id === decodedId || s.slug === decodedId) return true;
        return Boolean(s.workspaceDir) && path.basename(s.workspaceDir) === decodedId;
      });
    if (!session) {
      res.writeHead(404);
      return res.end('Session not found');
    }
    const targetPath = path.join(session.workspaceDir, relFile);
    if (!targetPath.startsWith(session.workspaceDir) || !fs.existsSync(targetPath)) {
      res.writeHead(404);
      return res.end('File not found');
    }
    const ext = path.extname(targetPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(targetPath));
  }

  // Unknown /api/* must never fall through to the SPA HTML.
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: 'not_found', path: pathname });
  }

  // Serve static files from museswarm-studio/dist first, then /public.
  // Docker images omit dist (see .dockerignore) so hosted demo serves public/,
  // which the Studio bundle PR rebuilds. Dist is never copied stale into the image.
  const studioDistDir = path.join(CONFIG.rootDir, 'museswarm-studio', 'dist');
  const publicDir = path.join(CONFIG.rootDir, 'public');
  const staticRoots = [studioDistDir, publicDir].filter((d) => fs.existsSync(d));

  const cleanRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  for (const root of staticRoots) {
    const candidate = path.join(root, cleanRel);
    if (candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(candidate));
    }
  }

  // SPA fallback to index.html
  for (const root of staticRoots) {
    const indexCandidate = path.join(root, 'index.html');
    if (fs.existsSync(indexCandidate)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(indexCandidate));
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

if (require.main === module) {
  server.listen(CONFIG.port, () => {
    console.log(`\n🚀 MuseSwarm Live Studio running at http://localhost:${CONFIG.port}`);
    console.log(`   Model    : ${CONFIG.modelId}`);
    console.log(`   Endpoint : ${CONFIG.basetenBaseUrl} (2M TPM capacity)`);
    if (CONFIG.publicDemo) {
      console.log(`   Mode     : public-demo (goldens loaded, live Baseten disabled)\n`);
    } else {
      console.log('');
    }
  });
}

module.exports = { server, engine, normalizeAgentId };
