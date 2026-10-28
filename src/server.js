const http = require('http');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');
const { MuseSwarmEngine, AGENT_PROFILES } = require('./swarm-engine');

const engine = new MuseSwarmEngine();
const sseClients = new Set();

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
          engine.sessions.set(saved.id, saved);
          engine.activeSessionId = saved.id;
        } catch (_) {}
      } else if (fs.existsSync(path.join(wsDir, 'app.js'))) {
        // Rehydrate legacy workspace folder that did not have .session.json
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
            ObserverAdvisories: [],
            telemetry: engine.client.getTelemetry(),
          };
          engine.sessions.set(id, session);
          if (!engine.activeSessionId) engine.activeSessionId = id;
        } catch (_) {}
      }
    }
  }
}

loadExistingWorkspaces();

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
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // SSE stream
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ eventType: 'connected', telemetry: engine.client.getTelemetry() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
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
      uptimeSec: Math.round(process.uptime()),
      modelId: CONFIG.modelId,
      endpoint: CONFIG.basetenBaseUrl,
      telemetry: engine.client.getTelemetry(),
      sessionsCount: sessions.length,
      benchmarks,
    });
  }

  // Status & Telemetry
  if (pathname === '/api/status' && req.method === 'GET') {
    const sessions = Array.from(engine.sessions.values()).map((s) => engine.serializeSession(s));
    return sendJson(res, 200, {
      ok: true,
      modelId: CONFIG.modelId,
      endpoint: CONFIG.basetenBaseUrl,
      agents: AGENT_PROFILES,
      telemetry: engine.client.getTelemetry(),
      sessions,
      activeSessionId: engine.activeSessionId,
    });
  }

  // Trigger a new multi-agent swarm run
  if (pathname === '/api/swarm/run' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const prompt = (body.prompt || '').trim();
      if (!prompt) {
        return sendJson(res, 400, { ok: false, error: 'Prompt is required' });
      }
      const session = engine.createSession({ prompt, projectName: body.projectName });
      // Run asynchronously so client watches SSE events in real time
      engine.executeSwarm(session).catch((err) => {
        console.error('Swarm run error:', err);
      });
      return sendJson(res, 200, {
        ok: true,
        session: engine.serializeSession(session),
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Direct chat/ping to a single specialist bot
  if (pathname === '/api/swarm/message' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const agentId = body.agent || 'architect';
      const message = (body.message || '').trim();
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
      if (session) {
        engine.postBotMessage(session, {
          from: '@user',
          to: profile.handle,
          delivery: 'steer',
          content: message,
        });
        engine.postBotMessage(session, {
          from: profile.handle,
          to: '@user',
          delivery: 'notify',
          content: llmRes.content,
          reasoning: llmRes.reasoningContent,
        });
      }

      return sendJson(res, 200, {
        ok: true,
        agent: profile,
        reply: llmRes.content,
        reasoning: llmRes.reasoningContent,
        usage: llmRes.usage,
        latencyMs: llmRes.latencyMs,
        telemetry: engine.client.getTelemetry(),
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
    const session = engine.sessions.get(sessionId);
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

  // Serve static files from /public
  const publicDir = path.join(CONFIG.rootDir, 'public');
  let staticFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const fullStaticPath = path.join(publicDir, staticFile);
  if (fullStaticPath.startsWith(publicDir) && fs.existsSync(fullStaticPath) && fs.statSync(fullStaticPath).isFile()) {
    const ext = path.extname(fullStaticPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8' });
    return res.end(fs.readFileSync(fullStaticPath));
  }

  res.writeHead(404);
  res.end('Not found');
});

if (require.main === module) {
  server.listen(CONFIG.port, () => {
    console.log(`\n🚀 MuseSwarm Live Studio running at http://localhost:${CONFIG.port}`);
    console.log(`   Model    : ${CONFIG.modelId}`);
    console.log(`   Endpoint : ${CONFIG.basetenBaseUrl} (2M TPM capacity)\n`);
  });
}

module.exports = { server, engine };
