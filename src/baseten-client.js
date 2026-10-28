const { CONFIG, loadEnv } = require('./config');

function computePercentile(sortedValues, percentile) {
  if (!sortedValues || sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1)
  );
  return Math.round(sortedValues[idx]);
}

class BasetenMuseClient {
  constructor(options = {}) {
    loadEnv();
    this.apiKey =
      options.apiKey !== undefined
        ? options.apiKey
        : process.env.BASETEN_API_KEY || process.env.META_API_KEY || CONFIG.basetenApiKey;
    this.baseUrl = (options.baseUrl || CONFIG.basetenBaseUrl).replace(/\/+$/, '');
    this.modelId = options.modelId || CONFIG.modelId;
    this.tpmLimit = options.tpmLimit || CONFIG.tpmLimit;
    this.timeoutMs = options.timeoutMs || CONFIG.requestTimeoutMs || 45000;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : (CONFIG.maxRetries || 3);
    this.retryBaseDelayMs = options.retryBaseDelayMs !== undefined ? options.retryBaseDelayMs : (CONFIG.retryBaseDelayMs || 400);
    this.allowOfflineFallback =
      options.allowOfflineFallback !== undefined ? options.allowOfflineFallback : CONFIG.allowOfflineFallback;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;

    // Telemetry state
    this.tokenWindow = []; // [{ timestamp, totalTokens, promptTokens, completionTokens, reasoningTokens, cachedTokens, latencyMs, agentId }]
    this.latencies = [];   // All recorded call latencies in ms
    this.totalCalls = 0;
    this.totalTokensUsed = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalReasoningTokens = 0;
    this.totalCachedTokens = 0;
    this.totalLatencyMs = 0;
    this.retryCount = 0;
    this.errorCount = 0;
    this.simulatedCalls = 0;
    this.agentBreakdown = {}; // agentId -> { calls, totalTokens, reasoningTokens, totalLatencyMs }
  }

  recordUsage(usage, latencyMs, agentId = 'system', isSimulated = false) {
    const now = Date.now();
    const promptTokens = usage?.prompt_tokens ?? usage?.promptTokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? usage?.completionTokens ?? 0;
    const totalTokens = usage?.total_tokens ?? usage?.totalTokens ?? promptTokens + completionTokens;
    const reasoningTokens =
      usage?.completion_tokens_details?.reasoning_tokens ??
      usage?.reasoning_tokens ??
      usage?.reasoningTokens ??
      0;
    const cachedTokens =
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.cached_tokens ??
      usage?.cachedTokens ??
      0;

    this.tokenWindow.push({
      timestamp: now,
      totalTokens,
      promptTokens,
      completionTokens,
      reasoningTokens,
      cachedTokens,
      latencyMs,
      agentId,
    });

    // Prune older than 60s for rolling 2M TPM calculation
    const cutoff = now - 60000;
    this.tokenWindow = this.tokenWindow.filter((entry) => entry.timestamp >= cutoff);

    this.latencies.push(latencyMs);
    if (this.latencies.length > 500) {
      this.latencies.shift();
    }

    this.totalCalls += 1;
    if (isSimulated) this.simulatedCalls += 1;
    this.totalTokensUsed += totalTokens;
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalReasoningTokens += reasoningTokens;
    this.totalCachedTokens += cachedTokens;
    this.totalLatencyMs += latencyMs;

    if (!this.agentBreakdown[agentId]) {
      this.agentBreakdown[agentId] = {
        calls: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        totalLatencyMs: 0,
      };
    }
    this.agentBreakdown[agentId].calls += 1;
    this.agentBreakdown[agentId].totalTokens += totalTokens;
    this.agentBreakdown[agentId].reasoningTokens += reasoningTokens;
    this.agentBreakdown[agentId].totalLatencyMs += latencyMs;
  }

  getTelemetry() {
    const now = Date.now();
    const cutoff = now - 60000;
    const recent = this.tokenWindow.filter((e) => e.timestamp >= cutoff);
    const currentTpm = recent.reduce((acc, e) => acc + e.totalTokens, 0);
    const currentRpm = recent.length;
    const avgLatencyMs = this.totalCalls > 0 ? Math.round(this.totalLatencyMs / this.totalCalls) : 0;

    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const p50LatencyMs = computePercentile(sortedLatencies, 50);
    const p95LatencyMs = computePercentile(sortedLatencies, 95);
    const minLatencyMs = sortedLatencies.length > 0 ? Math.round(sortedLatencies[0]) : 0;
    const maxLatencyMs = sortedLatencies.length > 0 ? Math.round(sortedLatencies[sortedLatencies.length - 1]) : 0;

    const hasApiKey = Boolean(
      this.apiKey &&
      this.apiKey.length > 8 &&
      this.apiKey !== 'your_baseten_api_key_here'
    );

    return {
      modelId: this.modelId,
      endpoint: this.baseUrl,
      tpmLimit: this.tpmLimit,
      currentTpm,
      currentRpm,
      tpmUtilizationPct: Number(((currentTpm / this.tpmLimit) * 100).toFixed(3)),
      totalCalls: this.totalCalls,
      simulatedCalls: this.simulatedCalls,
      liveCalls: this.totalCalls - this.simulatedCalls,
      totalTokensUsed: this.totalTokensUsed,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      totalCachedTokens: this.totalCachedTokens,
      avgLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      minLatencyMs,
      maxLatencyMs,
      retryCount: this.retryCount,
      errorCount: this.errorCount,
      agentBreakdown: this.agentBreakdown,
      hasApiKey,
      mode: hasApiKey ? 'live-baseten' : (this.allowOfflineFallback ? 'offline-deterministic-fallback' : 'unconfigured'),
    };
  }

  buildOfflineFallbackResponse({ agentId, messages }) {
    const userMsg = (messages.find((m) => m.role === 'user')?.content || '').slice(0, 600);
    const startTime = Date.now();
    let reasoningContent = '';
    let content = '';

    if (agentId === 'architect') {
      reasoningContent =
        'Analyzing software prompt for @architect. Decomposing architecture into brief.md, runbook.md, and parallelizable Kanban tasks (TASK-1A core engine, TASK-1B UI & tests, TASK-2 verification, TASK-3 release synthesis).';
      content = '```json\n' + JSON.stringify({
        projectTitle: 'MuseSwarm Engineering Sprint & Incident Priority Studio',
        briefMd: `# Project Brief\n\n## Overview\nBuilt collaboratively by **MuseSwarm** (\`@architect\`, \`@builder\`, \`@verifier\`, \`@lead\`).\n\n## Core Architecture\n- \`app.js\`: Isomorphic priority scoring & SLA breach engine (Node.js CommonJS + Browser \`globalThis.AppCore\`).\n- \`index.html\`: Interactive dark-mode operational studio.\n- \`test.js\`: Zero-dependency automated verification suite using Node \`assert\`.`,
        runbookMd: `# Runbook\n\n## Module Contracts\n1. \`app.js\` exports \`TaskPriorityEngine\` with \`addItem\`, \`getRankedItems\`, \`completeItem\`, \`getSlaBreaches\`, and \`getSummary\`.\n2. \`index.html\` loads \`app.js\` and renders interactive priority cards.\n3. \`test.js\` validates normal ranking, SLA breach detection, status transitions, and input validation edge cases.`,
        parallelModules: [
          {
            id: 'MOD-CORE',
            targetFile: 'app.js',
            title: 'Isomorphic Priority & SLA Core Engine',
            description: 'Implement TaskPriorityEngine in app.js with CommonJS + globalThis.AppCore export.',
          },
          {
            id: 'MOD-UI-TEST',
            targetFile: 'index.html,test.js',
            title: 'Interactive Dark-Mode Dashboard & Unit Test Suite',
            description: 'Implement index.html and automated assertions in test.js.',
          },
        ],
        kanbanTasks: [
          {
            id: 'TASK-1',
            title: 'Core Logic, Interactive UI & Unit Tests Implementation',
            assignee: '@builder',
            description: 'Implement app.js, index.html, and test.js following runbook.md contracts.',
            acceptanceCriteria: [
              'app.js works in both Node.js CommonJS and browser DOM',
              'index.html provides interactive dark-mode UI',
              'test.js runs at least 5 automated assertions and exits 0',
            ],
          },
          {
            id: 'TASK-2',
            title: 'Runtime Verification, Rubric Scoring & Edge-Case Audit',
            assignee: '@verifier',
            parentId: 'TASK-1',
            description: 'Execute node --check and node test.js, score quality rubric, and trigger rework if needed.',
            acceptanceCriteria: ['node test.js exits 0', 'Rubric score >= 85/100'],
          },
          {
            id: 'TASK-3',
            title: 'Documentation, Benchmark & Launch Synthesis',
            assignee: '@lead',
            parentId: 'TASK-2',
            description: 'Produce README.md and benchmark summary based on verified artifacts.',
            acceptanceCriteria: ['Complete README.md with usage instructions'],
          },
        ],
        messageToBuilder: '@builder I have published brief.md and runbook.md. Implement TASK-1 with isomorphic exports in app.js, interactive UI in index.html, and assertions in test.js.',
        messageToVerifier: '@verifier Prepare sandbox verification and rubric audit for TASK-2 once @builder completes TASK-1.',
      }, null, 2) + '\n```';
    } else if (agentId === 'verifier') {
      reasoningContent =
        'Inspecting sandbox execution results (node --check and node test.js) and evaluating code quality rubric across correctness, test coverage, modularity, and UI completeness.';
      content = '```json\n' + JSON.stringify({
        verdict: 'VERIFIED_PASS',
        qualityScore: 97,
        rubric: {
          correctness: 25,
          testCoverage: 24,
          architectureAdherence: 24,
          uiCompleteness: 24,
        },
        messageToBuilder: '@builder Peer audit complete. Isomorphic exports, input validation, and all runtime assertions passed cleanly.',
        messageToLead: '@lead Verification passed (VERIFIED_PASS, 97/100). Handing off TASK-3 for README.md and benchmark synthesis.',
      }, null, 2) + '\n```';
    } else if (agentId === 'lead') {
      reasoningContent =
        'Synthesizing final project README.md and multi-agent benchmark summary for the completed MuseSwarm workspace.';
      content = '```json\n' + JSON.stringify({
        readmeMd: `# MuseSwarm Co-Built Application\n\nAutonomously architected, implemented, verified, and documented by **MuseSwarm** (\`@architect\`, \`@builder\`, \`@verifier\`, \`@lead\`).\n\n## Quick Start\n\`\`\`bash\nnode test.js\n\`\`\`\n\n## Live Web App\nOpen \`index.html\` in your browser or inspect via the MuseSwarm Studio Live Preview tab.`,
        finalBroadcast: '@all Release package and benchmark telemetry synthesized! All Kanban tasks (TASK-1, TASK-2, TASK-3) passed verification.',
      }, null, 2) + '\n```';
    } else {
      reasoningContent = `Processing request for @${agentId}: "${userMsg.slice(0, 120)}..."`;
      content = `[@${agentId}] Ready and online in MuseSwarm (${this.modelId}). All session bus channels and Kanban protocols active.`;
    }

    const latencyMs = Math.max(8, Date.now() - startTime + 12);
    const promptTokens = Math.max(32, Math.ceil(userMsg.length / 4));
    const reasoningTokens = Math.max(24, Math.ceil(reasoningContent.length / 4));
    const completionTokens = Math.max(48, Math.ceil(content.length / 4)) + reasoningTokens;
    const totalTokens = promptTokens + completionTokens;

    this.recordUsage(
      {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        completion_tokens_details: { reasoning_tokens: reasoningTokens },
      },
      latencyMs,
      agentId,
      true
    );

    return {
      id: `sim-${Date.now().toString(36)}`,
      model: this.modelId,
      simulated: true,
      content,
      reasoningContent,
      finishReason: 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        cachedTokens: 0,
      },
      latencyMs,
      telemetry: this.getTelemetry(),
    };
  }

  async chatCompletion({
    messages,
    maxTokens = 4096,
    temperature = 0.3,
    agentId = 'system',
    onProgress = null,
    timeoutMs = null,
  }) {
    // Re-check env in case .env was populated after startup
    if (!this.apiKey || this.apiKey === 'your_baseten_api_key_here') {
      loadEnv();
      if (process.env.BASETEN_API_KEY && process.env.BASETEN_API_KEY !== 'your_baseten_api_key_here') {
        this.apiKey = process.env.BASETEN_API_KEY;
      }
    }

    const hasValidKey = Boolean(this.apiKey && this.apiKey.length > 8 && this.apiKey !== 'your_baseten_api_key_here');

    if (!hasValidKey) {
      if (this.allowOfflineFallback) {
        if (onProgress) {
          onProgress({ type: 'llm_start', agentId, model: this.modelId, simulated: true, timestamp: Date.now() });
        }
        const simResult = this.buildOfflineFallbackResponse({ agentId, messages });
        if (onProgress) {
          onProgress({
            type: 'llm_complete',
            agentId,
            simulated: true,
            latencyMs: simResult.latencyMs,
            usage: simResult.usage,
            telemetry: simResult.telemetry,
          });
        }
        return simResult;
      }
      throw new Error('BASETEN_API_KEY is not set. Add it to .env or environment variables.');
    }

    const startTime = Date.now();
    const url = `${this.baseUrl}/chat/completions`;
    const effectiveTimeout = timeoutMs || this.timeoutMs;

    const body = {
      model: this.modelId,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    if (onProgress) {
      onProgress({ type: 'llm_start', agentId, model: this.modelId, timestamp: startTime });
    }

    let lastErr = null;
    const totalAttempts = Math.max(1, this.maxRetries);

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);

      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const errText = await res.text();
          const status = res.status;
          const isRetryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
          const err = new Error(`Baseten HTTP ${status}: ${errText.slice(0, 300)}`);
          err.status = status;
          err.retryable = isRetryable;

          // Respect Retry-After header if present on 429/503
          const retryAfterHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
          if (retryAfterHeader) {
            const parsedSec = parseFloat(retryAfterHeader);
            if (!Number.isNaN(parsedSec) && parsedSec > 0) {
              err.retryAfterMs = Math.min(15000, Math.round(parsedSec * 1000));
            }
          }
          throw err;
        }

        const data = await res.json();
        const latencyMs = Date.now() - startTime;
        const choice = data.choices && data.choices[0] ? data.choices[0] : {};
        const msg = choice.message || {};

        let content = msg.content || '';
        let reasoningContent =
          msg.reasoning_content ||
          msg.reasoning ||
          choice.reasoning_content ||
          '';

        // Extract <think>...</think> if model emitted inline think tags
        if (!reasoningContent && typeof content === 'string') {
          const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>\s*/i);
          if (thinkMatch) {
            reasoningContent = thinkMatch[1].trim();
            content = content.slice(thinkMatch[0].length);
          }
        }

        const usage = data.usage || {};
        this.recordUsage(usage, latencyMs, agentId, false);

        const result = {
          id: data.id,
          model: data.model || this.modelId,
          simulated: false,
          content,
          reasoningContent,
          finishReason: choice.finish_reason,
          usage: {
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            totalTokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || usage.reasoning_tokens || 0,
            cachedTokens: usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0,
          },
          latencyMs,
          telemetry: this.getTelemetry(),
        };

        if (onProgress) {
          onProgress({
            type: 'llm_complete',
            agentId,
            latencyMs,
            usage: result.usage,
            telemetry: result.telemetry,
          });
        }

        return result;
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          const timeoutErr = new Error(`Baseten request timed out after ${effectiveTimeout}ms`);
          timeoutErr.code = 'ETIMEDOUT';
          timeoutErr.retryable = true;
          lastErr = timeoutErr;
        } else {
          lastErr = err;
        }

        const canRetry =
          attempt < totalAttempts &&
          (lastErr.retryable !== false);

        if (canRetry) {
          this.retryCount += 1;
          const jitter = Math.floor(Math.random() * 120);
          const backoffMs =
            lastErr.retryAfterMs ||
            Math.min(8000, this.retryBaseDelayMs * Math.pow(2, attempt - 1) + jitter);

          if (onProgress) {
            onProgress({
              type: 'llm_retry',
              agentId,
              attempt,
              maxRetries: totalAttempts,
              backoffMs,
              reason: lastErr.message,
            });
          }
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          this.errorCount += 1;
          break;
        }
      }
    }

    throw lastErr;
  }
}

module.exports = { BasetenMuseClient, computePercentile };
