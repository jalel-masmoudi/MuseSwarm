#!/usr/bin/env node
/**
 * MuseSwarm MCP Server for Cursor IDE & Muse Code CLI
 * Exposes stdio JSON-RPC 2.0 MCP tools so Cursor can directly orchestrate
 * @architect, @builder, @verifier, and @lead on Baseten Muse Spark Open.
 */
const readline = require('readline');
const { CONFIG } = require('./config');
const { MuseSwarmEngine, AGENT_PROFILES } = require('./swarm-engine');

const engine = new MuseSwarmEngine();

const TOOLS = [
  {
    name: 'muse_swarm_list_agents',
    description: 'List the specialized MuseSwarm bots (@architect, @builder, @verifier, @lead), their toolsets, and Baseten Muse Spark Open telemetry.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'muse_swarm_ask_agent',
    description: 'Send a direct peer message to a specific MuseSwarm specialist (@architect, @builder, @verifier, or @lead) powered by meta-models/muse-spark-open-1026 on Baseten.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          enum: ['architect', 'builder', 'verifier', 'lead'],
          description: 'Target specialist agent ID',
        },
        message: {
          type: 'string',
          description: 'Question, code snippet, or task to send to the specialist bot',
        },
      },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'muse_swarm_cobuild',
    description: 'Run a full autonomous multi-agent bot-to-bot software build session (@architect -> @builder -> @verifier -> @lead) with Kanban tracking, rubric scoring, and sandbox test verification.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Software feature or application specification for the swarm to co-build and verify',
        },
        projectName: {
          type: 'string',
          description: 'Optional short slug for the output workspace folder',
        },
        scenarioId: {
          type: 'string',
          enum: ['sprint-priority-engine', 'feature-flag-rollout', 'oncall-fairness-scheduler'],
          description: 'Optional judge scenario preset to materialize as a multi-file workspace',
        },
        simulateBrokenFirstPass: {
          type: 'boolean',
          description: 'Inject the scenario Pass 1 fault so @verifier and @builder run the self-heal diff loop',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'muse_swarm_telemetry',
    description: 'Retrieve Baseten Muse Spark Open 2M TPM rolling window utilization, p50/p95 latency percentiles, reasoning token statistics, and active swarm session benchmarks.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function sendResponse(id, result) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(payload + '\n');
}

function sendError(id, code, message) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
  process.stdout.write(payload + '\n');
}

async function executeToolCall(toolName, args = {}, eng = engine) {
  const active = eng || engine;
  try {
    if (toolName === 'muse_swarm_list_agents') {
      return {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  model: CONFIG.modelId,
                  endpoint: CONFIG.basetenBaseUrl,
                  agents: AGENT_PROFILES,
                  telemetry: active.client.getTelemetry(),
                },
                null,
                2
              ),
            },
          ],
        },
      };
    }

    if (toolName === 'muse_swarm_telemetry') {
      const benchmarks = Array.from(active.sessions.values())
        .map((s) => s.benchmark)
        .filter(Boolean);
      return {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  telemetry: active.client.getTelemetry(),
                  sessionsCount: active.sessions.size,
                  benchmarks,
                },
                null,
                2
              ),
            },
          ],
        },
      };
    }

    if (toolName === 'muse_swarm_ask_agent') {
      const agentId = args.agent || 'architect';
      const profile = AGENT_PROFILES[agentId] || AGENT_PROFILES.architect;
      const res = await active.client.chatCompletion({
        agentId,
        maxTokens: 2048,
        messages: [
          {
            role: 'system',
            content: `You are ${profile.handle} (${profile.name} — ${profile.role}) in a MuseSwarm multi-agent team powered by Meta Muse Spark Open.`,
          },
          { role: 'user', content: args.message || 'Status check' },
        ],
      });
      return {
        result: {
          content: [
            {
              type: 'text',
              text:
                `[${profile.handle} | ${res.latencyMs}ms | ${res.usage.totalTokens} tokens]\n\n` +
                (res.reasoningContent ? `> **Reasoning Trace:** ${res.reasoningContent.slice(0, 400)}...\n\n` : '') +
                res.content,
            },
          ],
        },
      };
    }

    if (toolName === 'muse_swarm_cobuild') {
      const session = active.createSession({
        prompt: args.prompt,
        projectName: args.projectName,
        scenarioId: args.scenarioId,
        simulateBrokenFirstPass: Boolean(args.simulateBrokenFirstPass),
      });
      await active.executeSwarm(session);
      const serialized = active.serializeSession(session);
      return {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  sessionId: serialized.id,
                  status: serialized.status,
                  scenarioId: serialized.scenarioId,
                  workspaceDir: serialized.workspaceDir,
                  filesWritten: serialized.files.map((f) => f.path),
                  reworkDiffs: serialized.reworkDiffs,
                  rubricEvaluation: serialized.rubricEvaluation,
                  benchmark: serialized.benchmark,
                  messagesExchanged: serialized.messages.map((m) => ({
                    from: m.from,
                    to: m.to,
                    delivery: m.delivery,
                    content: m.content,
                  })),
                  verificationPassed: serialized.verificationRuns.slice(-1)[0]?.passed ?? false,
                  telemetry: serialized.telemetry,
                },
                null,
                2
              ),
            },
          ],
        },
      };
    }

    return { error: { code: -32601, message: `Unknown tool: ${toolName}` } };
  } catch (err) {
    return {
      result: {
        isError: true,
        content: [{ type: 'text', text: `Error executing ${toolName}: ${err.message}` }],
      },
    };
  }
}

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return sendResponse(id, {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'muse-swarm-mcp',
        version: '1.1.0',
      },
      capabilities: {
        tools: {},
      },
    });
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'tools/list') {
    return sendResponse(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const outcome = await executeToolCall(params?.name, params?.arguments || {});
    if (outcome.error) return sendError(id, outcome.error.code, outcome.error.message);
    return sendResponse(id, outcome.result);
  }

  if (id !== undefined) {
    sendResponse(id, {});
  }
}

if (require.main === module) {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed);
      handleRequest(req);
    } catch (_) {}
  });
}

module.exports = { TOOLS, handleRequest, executeToolCall, engine };
