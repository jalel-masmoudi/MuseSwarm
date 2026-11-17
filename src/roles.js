const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

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

module.exports = { AGENT_PROFILES, loadSoul };
