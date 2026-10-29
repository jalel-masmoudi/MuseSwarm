const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
      break;
    }
  }
}

loadEnv();

const CONFIG = {
  basetenApiKey: process.env.BASETEN_API_KEY || process.env.META_API_KEY || '',
  basetenBaseUrl: (process.env.BASETEN_BASE_URL || 'https://inference.baseten.co/v1').replace(/\/+$/, ''),
  modelId: process.env.MUSE_MODEL_ID || 'meta-models/muse-spark-open-1026',
  port: parseInt(process.env.PORT || '4321', 10),
  tpmLimit: parseInt(process.env.MUSE_SWARM_TPM_LIMIT || '2000000', 10),
  requestTimeoutMs: parseInt(process.env.MUSE_SWARM_TIMEOUT_MS || '45000', 10),
  // File-bearing calls (@architect / @builder / @lead) stream large replies plus reasoning.
  longRequestTimeoutMs: parseInt(process.env.MUSE_SWARM_LONG_TIMEOUT_MS || '120000', 10),
  maxRetries: parseInt(process.env.MUSE_SWARM_MAX_RETRIES || '3', 10),
  retryBaseDelayMs: parseInt(process.env.MUSE_SWARM_RETRY_BASE_MS || '400', 10),
  maxReworkLoops: parseInt(process.env.MUSE_SWARM_MAX_REWORK || '2', 10),
  allowOfflineFallback: process.env.MUSE_SWARM_OFFLINE_FALLBACK !== 'false',
  publicDemo: process.env.MUSE_SWARM_PUBLIC_DEMO === '1',
  publicDemoPostLimit: parseInt(process.env.MUSE_SWARM_PUBLIC_DEMO_POST_LIMIT || '12', 10),
  publicDemoPostWindowMs: parseInt(process.env.MUSE_SWARM_PUBLIC_DEMO_POST_WINDOW_MS || '60000', 10),
  publicDemoMaxConcurrent: parseInt(process.env.MUSE_SWARM_PUBLIC_DEMO_MAX_CONCURRENT || '2', 10),
  publicDemoMaxWorkspaces: parseInt(process.env.MUSE_SWARM_DEMO_MAX_WORKSPACES || '20', 10),
  publicDemoWorkspaceTtlMs: parseInt(process.env.MUSE_SWARM_DEMO_WORKSPACE_TTL_MS || String(30 * 60 * 1000), 10),
  publicDemoSweepMs: parseInt(process.env.MUSE_SWARM_DEMO_SWEEP_MS || '60000', 10),
  sseReplayMinMs: parseInt(process.env.MUSE_SWARM_SSE_REPLAY_MS || '40', 10),
  sseReplayMaxMs: parseInt(process.env.MUSE_SWARM_SSE_REPLAY_MAX_MS || '400', 10),
  rootDir: path.resolve(__dirname, '..'),
  workspacesDir: path.resolve(__dirname, '..', 'workspaces'),
  profilesDir: path.resolve(__dirname, '..', 'profiles'),
};

module.exports = { CONFIG, loadEnv };
