const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(process.cwd(), 'Agents');

function ensureWorkspace(agent) {
  if (!agent?.id || !agent?.user_id) return null;
  const dir = workspaceDir(agent.user_id, agent.id);
  fs.mkdirSync(dir, { recursive: true });
  writeSpec(agent, dir);
  const agentDb = openAgentDb(dir);
  try {
    recordEvent(agentDb, 'workspace.synced', {
      agentId: agent.id,
      name: agent.name,
      status: agent.status,
      brainId: agent.brain_id,
    });
  } finally {
    agentDb.close();
  }
  return summarizeWorkspace(agent, dir);
}

function syncAgents(agents = []) {
  return agents.map((agent) => ({ ...agent, workspace: ensureWorkspace(agent) })).filter(Boolean);
}

function recordRecommendation(agent, recommendation, councilRun) {
  if (!agent?.id || !agent?.user_id) return;
  const dir = workspaceDir(agent.user_id, agent.id);
  fs.mkdirSync(dir, { recursive: true });
  const agentDb = openAgentDb(dir);
  try {
    agentDb.prepare(`
      INSERT INTO agent_recommendations (
        council_run_id, symbol, action, conviction, rationale, evidence_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      councilRun?.id || null,
      recommendation.symbol,
      recommendation.action,
      recommendation.conviction,
      recommendation.rationale || null,
      JSON.stringify(recommendation.evidence || {})
    );
    recordEvent(agentDb, 'council.recommendation', {
      councilRunId: councilRun?.id || null,
      symbol: recommendation.symbol,
      action: recommendation.action,
      conviction: recommendation.conviction,
    });
  } finally {
    agentDb.close();
  }
}

function recordLearningAdjustment(agent, { previousWeight, newWeight, accuracy, sampleSize, rationale }) {
  if (!agent?.id || !agent?.user_id) return;
  const dir = workspaceDir(agent.user_id, agent.id);
  fs.mkdirSync(dir, { recursive: true });
  const agentDb = openAgentDb(dir);
  try {
    const value = { previousWeight, newWeight, accuracy, sampleSize, rationale, adjustedAt: new Date().toISOString() };
    agentDb.prepare(`
      INSERT INTO agent_memory (key, value_json, updated_at)
      VALUES ('learning-weight', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(value));
    recordEvent(agentDb, 'learning.weight.adjusted', value);
  } finally {
    agentDb.close();
  }
}

function exportWorkspace(agent) {
  const dir = workspaceDir(agent.user_id, agent.id);
  ensureWorkspace(agent);
  const agentDb = openAgentDb(dir);
  try {
    return {
      exportedAt: new Date().toISOString(),
      spec: readSpec(dir),
      database: {
        events: agentDb.prepare('SELECT * FROM agent_events ORDER BY created_at DESC, id DESC LIMIT 500').all(),
        recommendations: agentDb.prepare('SELECT * FROM agent_recommendations ORDER BY created_at DESC, id DESC LIMIT 500').all(),
        memory: agentDb.prepare('SELECT * FROM agent_memory ORDER BY updated_at DESC, key LIMIT 500').all(),
      },
    };
  } finally {
    agentDb.close();
  }
}

function markDeleted(agent) {
  const workspace = ensureWorkspace({ ...agent, status: 'deleted' });
  if (!workspace) return null;
  const agentDb = openAgentDb(workspace.path);
  try {
    recordEvent(agentDb, 'agent.deleted', { agentId: agent.id, name: agent.name });
  } finally {
    agentDb.close();
  }
  return workspace;
}

function workspaceDir(userId, agentId) {
  return path.join(ROOT, `user-${userId}`, `agent-${agentId}`);
}

function openAgentDb(dir) {
  const agentDb = new Database(path.join(dir, 'agent.sqlite'));
  agentDb.pragma('journal_mode = WAL');
  agentDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      council_run_id INTEGER,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      conviction REAL NOT NULL DEFAULT 0,
      rationale TEXT,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_memory (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return agentDb;
}

function writeSpec(agent, dir) {
  const spec = {
    id: agent.id,
    userId: agent.user_id,
    name: agent.name,
    slug: agent.slug,
    status: agent.status,
    brainId: agent.brain_id,
    persona: agent.persona || {},
    bias: agent.bias || {},
    sourceUrls: agent.sourceUrls || [],
    model: agent.model || {},
    workspace: {
      path: dir,
      database: path.join(dir, 'agent.sqlite'),
      spec: path.join(dir, 'agent.json'),
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'agent.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
}

function readSpec(dir) {
  const file = path.join(dir, 'agent.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function recordEvent(agentDb, eventType, payload) {
  agentDb.prepare('INSERT INTO agent_events (event_type, payload_json) VALUES (?, ?)').run(eventType, JSON.stringify(payload || {}));
}

function summarizeWorkspace(agent, dir) {
  return {
    path: dir,
    database: path.join(dir, 'agent.sqlite'),
    spec: path.join(dir, 'agent.json'),
  };
}

module.exports = {
  ensureWorkspace,
  syncAgents,
  recordRecommendation,
  recordLearningAdjustment,
  exportWorkspace,
  markDeleted,
};
