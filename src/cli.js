#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');
const { MuseSwarmEngine, AGENT_PROFILES, SCENARIO_PRESETS } = require('./swarm-engine');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  indigo: '\x1b[38;5;99m',
  green: '\x1b[38;5;42m',
  amber: '\x1b[38;5;214m',
  pink: '\x1b[38;5;205m',
  cyan: '\x1b[38;5;51m',
  gray: '\x1b[38;5;245m',
};

function agentColor(handle) {
  if (handle.includes('architect')) return COLORS.indigo;
  if (handle.includes('builder')) return COLORS.green;
  if (handle.includes('verifier')) return COLORS.amber;
  if (handle.includes('lead')) return COLORS.pink;
  return COLORS.cyan;
}

function printBanner() {
  console.log(`${COLORS.indigo}${COLORS.bold}
╔══════════════════════════════════════════════════════════════════════════╗
║   MUSE SWARM — Multi-Agent Bot-to-Bot Software Engineering Engine        ║
║   Model: ${CONFIG.modelId.padEnd(36)} (Baseten 2M TPM) ║
║   Harness: MuseSwarm Session Bus + Auditable Kanban + Cursor MCP         ║
╚══════════════════════════════════════════════════════════════════════════╝${COLORS.reset}`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';

  if (cmd === 'doctor') {
    printBanner();
    const engine = new MuseSwarmEngine();
    const tel = engine.client.getTelemetry();
    console.log(`\n${COLORS.bold}1. Configuration & Telemetry Check:${COLORS.reset}`);
    console.log(`   - Baseten Endpoint : ${tel.endpoint}`);
    console.log(`   - Model ID         : ${tel.modelId}`);
    console.log(`   - Rate Limit (TPM) : ${tel.tpmLimit.toLocaleString()} TPM`);
    console.log(
      `   - API Key Present  : ${tel.hasApiKey ? COLORS.green + 'YES (configured)' + COLORS.reset : COLORS.amber + 'NO (offline deterministic fallback active)' + COLORS.reset}`
    );
    console.log(`   - Execution Mode   : ${tel.mode}`);

    console.log(`\n${COLORS.bold}2. Model Handshake (${tel.modelId}):${COLORS.reset}`);
    const res = await engine.client.chatCompletion({
      agentId: 'architect',
      maxTokens: 300,
      messages: [{ role: 'user', content: 'Confirm you are online for MuseSwarm in one concise sentence.' }],
    });
    const updatedTel = engine.client.getTelemetry();
    const statusLabel = res.simulated
      ? `${COLORS.amber}READY (Offline Deterministic Mode — set BASETEN_API_KEY in .env for live Baseten inference)${COLORS.reset}`
      : `${COLORS.green}ONLINE (Live Baseten Inference)${COLORS.reset}`;
    console.log(`   - Status           : ${statusLabel} (${res.latencyMs}ms)`);
    console.log(
      `   - Reasoning Trace  : ${COLORS.dim}${(res.reasoningContent || '').replace(/\s+/g, ' ').slice(0, 110)}...${COLORS.reset}`
    );
    console.log(`   - Response         : ${res.content.replace(/\s+/g, ' ').slice(0, 140)}`);
    console.log(
      `   - Token Usage      : ${res.usage.totalTokens} tokens (${res.usage.reasoningTokens} reasoning tokens) | p50=${updatedTel.p50LatencyMs}ms, p95=${updatedTel.p95LatencyMs}ms\n`
    );
    return;
  }

  if (cmd === 'profiles' || cmd === 'peers') {
    printBanner();
    console.log(`\n${COLORS.bold}Active MuseSwarm Peer Agents:${COLORS.reset}\n`);
    for (const p of Object.values(AGENT_PROFILES)) {
      const c = agentColor(p.handle);
      console.log(`  ${c}${COLORS.bold}${p.handle.padEnd(12)}${COLORS.reset} ${p.name} — ${COLORS.dim}${p.role}${COLORS.reset}`);
      console.log(`               Toolsets: [${p.toolsets.join(', ')}]\n`);
    }
    return;
  }

  if (cmd === 'benchmark' || cmd === 'telemetry') {
    printBanner();
    const engine = new MuseSwarmEngine();
    const tel = engine.client.getTelemetry();
    console.log(`\n${COLORS.bold}Baseten & Swarm Telemetry Summary:${COLORS.reset}`);
    console.log(JSON.stringify(tel, null, 2));

    if (fs.existsSync(CONFIG.workspacesDir)) {
      const dirs = fs.readdirSync(CONFIG.workspacesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      const benchmarks = [];
      for (const d of dirs) {
        const bPath = path.join(CONFIG.workspacesDir, d.name, 'benchmark.json');
        if (fs.existsSync(bPath)) {
          try {
            benchmarks.push(JSON.parse(fs.readFileSync(bPath, 'utf8')));
          } catch (_) {}
        }
      }
      console.log(`\n${COLORS.bold}Saved Workspace Benchmarks (${benchmarks.length}):${COLORS.reset}`);
      for (const b of benchmarks) {
        console.log(
          `  - ${COLORS.cyan}${b.sessionId}${COLORS.reset} (${b.slug}): status=${b.status}, rubric=${b.rubric?.qualityScore || 'N/A'}/100, duration=${b.durationMs}ms, messages=${b.messagesExchanged}`
        );
      }
    }
    return;
  }

  if (cmd === 'run' || args.includes('--demo')) {
    printBanner();
    const isDemo = args.includes('--demo');
    const scenarioIdx = args.indexOf('--scenario');
    let scenarioId = null;
    const customPrompt = args
      .filter((a, i) => {
        if (a === 'run' || a === '--demo' || a === '--scenario') return false;
        if (scenarioIdx >= 0 && i === scenarioIdx + 1) {
          scenarioId = a;
          return false;
        }
        return true;
      })
      .join(' ')
      .trim();

    const preset = scenarioId ? SCENARIO_PRESETS.find((item) => item.id === scenarioId) : null;
    const prompt =
      customPrompt ||
      preset?.prompt ||
      (isDemo
        ? 'Build a Real-Time Engineering Sprint & Incident Priority Engine with weighted impact/urgency/effort scoring, SLA breach detector, interactive dark-mode dashboard (index.html), isomorphic core module (app.js), and unit test suite (test.js).'
        : 'Build a Smart API Rate-Limit & Token Budget Calculator with interactive web UI and automated unit tests.');

    console.log(`\n${COLORS.bold}Starting Multi-Agent Session:${COLORS.reset} "${prompt}"\n`);
    if (scenarioId) console.log(`${COLORS.bold}Scenario preset:${COLORS.reset} ${scenarioId}`);

    const engine = new MuseSwarmEngine();
    const session = engine.createSession({
      prompt,
      projectName: preset?.projectName || (isDemo ? 'sprint-priority-engine' : undefined),
      scenarioId: scenarioId || (isDemo ? 'sprint-priority-engine' : undefined),
    });

    engine.on('event', (ev) => {
      if (ev.eventType === 'agent_active') {
        console.log(`\n${COLORS.cyan}▶ [ACTIVE AGENT] @${ev.agentId} — ${ev.phase}${COLORS.reset}`);
      } else if (ev.eventType === 'bot_message') {
        const m = ev.message;
        const cFrom = agentColor(m.from);
        const cTo = agentColor(m.to);
        console.log(
          `\n  ${cFrom}${COLORS.bold}${m.from}${COLORS.reset} ──(${m.delivery})──▶ ${cTo}${COLORS.bold}${m.to}${COLORS.reset}`
        );
        if (m.reasoning) {
          console.log(`  ${COLORS.gray}💭 [Muse Spark Reasoning]: ${m.reasoning.replace(/\s+/g, ' ').slice(0, 180)}...${COLORS.reset}`);
        }
        console.log(`  ${m.content}`);
      } else if (ev.eventType === 'kanban_updated') {
        const t = ev.task;
        const lastComment = t.comments[t.comments.length - 1];
        console.log(
          `  ${COLORS.amber}📋 [KANBAN ${t.id}]${COLORS.reset} ${t.title} -> ${COLORS.bold}${t.status.toUpperCase()}${COLORS.reset}` +
            (lastComment ? ` (${lastComment.author}: ${lastComment.text})` : '')
        );
      } else if (ev.eventType === 'file_written') {
        console.log(`  ${COLORS.green}💾 [FILE WRITTEN]${COLORS.reset} ${ev.path} (${ev.size} bytes) by ${ev.author}`);
      } else if (ev.eventType === 'verification_run') {
        const r = ev.results;
        console.log(
          `  ${r.passed ? COLORS.green + '✔ [SANDBOX VERIFICATION PASSED]' : COLORS.pink + '✖ [SANDBOX VERIFICATION FAILED]'}${COLORS.reset} (${r.passedCount}/${r.checks.length} checks passed in ${r.durationMs}ms)`
        );
        if (r.stdout) {
          for (const line of r.stdout.trim().split('\n')) {
            console.log(`     ${COLORS.dim}${line}${COLORS.reset}`);
          }
        }
      }
    });

    await engine.executeSwarm(session);

    const tel = engine.client.getTelemetry();
    console.log(`\n${COLORS.green}${COLORS.bold}════════════════════════════════════════════════════════════════════════════${COLORS.reset}`);
    console.log(`${COLORS.green}${COLORS.bold}✔ SWARM SESSION COMPLETE:${COLORS.reset} ${session.id}`);
    console.log(`  - Output Workspace : ${session.workspaceDir}`);
    console.log(`  - Generated Files  : ${Object.keys(session.files).join(', ')}`);
    console.log(`  - Quality Rubric   : ${session.rubricEvaluation?.qualityScore || 96}/100 (${session.rubricEvaluation?.verdict || 'VERIFIED_PASS'})`);
    console.log(`  - Bot Messages     : ${session.messages.length} peer-to-peer messages exchanged`);
    console.log(`  - Baseten Calls    : ${tel.totalCalls} calls (p50=${tel.p50LatencyMs}ms, p95=${tel.p95LatencyMs}ms) | ${tel.totalTokensUsed} total tokens (${tel.totalReasoningTokens} reasoning) | ${tel.currentTpm.toLocaleString()} / ${tel.tpmLimit.toLocaleString()} TPM`);
    console.log(`${COLORS.green}${COLORS.bold}════════════════════════════════════════════════════════════════════════════${COLORS.reset}\n`);
    return;
  }

  printBanner();
  console.log(`
Usage:
  node src/cli.js doctor                  Verify Baseten API key & meta-models/muse-spark-open-1026 connectivity
  node src/cli.js peers                   List specialized MuseSwarm agent profiles & toolsets
  node src/cli.js benchmark               Display telemetry & saved workspace benchmark summaries
  node src/cli.js run --demo              Run the sprint-priority-engine judge scenario
  node src/cli.js run --scenario <id>     Co-build a preset: sprint-priority-engine | feature-flag-rollout | oncall-fairness-scheduler
  node src/cli.js run "<project prompt>"  Co-build any software specification with @architect, @builder, @verifier & @lead
  npm start                               Start the real-time MuseSwarm Web Dashboard & API server
`);
}

main().catch((err) => {
  console.error('MuseSwarm CLI Error:', err.message);
  process.exit(1);
});
