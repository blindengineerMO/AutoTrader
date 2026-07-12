const db = require('../connection');

const upsertAgentStmt = db.prepare(`
  INSERT INTO trading_agents (
    user_id, name, slug, status, brain_id, persona_json, bias_json, source_urls_json, model_json
  )
  VALUES (
    @userId, @name, @slug, @status, @brainId, @personaJson, @biasJson, @sourceUrlsJson, @modelJson
  )
  ON CONFLICT(user_id, slug) DO UPDATE SET
    name = excluded.name,
    status = excluded.status,
    brain_id = excluded.brain_id,
    persona_json = excluded.persona_json,
    bias_json = excluded.bias_json,
    source_urls_json = excluded.source_urls_json,
    model_json = excluded.model_json,
    updated_at = datetime('now')
`);

const insertCouncilRunStmt = db.prepare(`
  INSERT INTO agent_council_runs (user_id, research_snapshot_id, conversation_id, status, summary_json)
  VALUES (@userId, @researchSnapshotId, @conversationId, @status, @summaryJson)
`);

const insertRecommendationStmt = db.prepare(`
  INSERT INTO agent_recommendations (
    council_run_id, agent_id, symbol, action, conviction, rationale, evidence_json
  )
  VALUES (@councilRunId, @agentId, @symbol, @action, @conviction, @rationale, @evidenceJson)
`);

const listAgentsStmt = db.prepare("SELECT * FROM trading_agents WHERE user_id = ? AND status != 'deleted' ORDER BY status = 'active' DESC, updated_at DESC");
const getAgentStmt = db.prepare('SELECT * FROM trading_agents WHERE user_id = ? AND id = ?');
const getBySlugStmt = db.prepare('SELECT * FROM trading_agents WHERE user_id = ? AND slug = ?');
const listRunsStmt = db.prepare('SELECT * FROM agent_council_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
const recommendationsForRunStmt = db.prepare(`
  SELECT r.*, a.name AS agent_name, a.slug AS agent_slug, a.brain_id AS agent_brain_id
  FROM agent_recommendations r
  JOIN trading_agents a ON a.id = r.agent_id
  WHERE r.council_run_id = ?
  ORDER BY r.conviction DESC, r.symbol
`);
const updateAgentStmt = db.prepare(`
  UPDATE trading_agents SET
    name = @name,
    status = @status,
    brain_id = @brainId,
    persona_json = @personaJson,
    bias_json = @biasJson,
    source_urls_json = @sourceUrlsJson,
    model_json = @modelJson,
    updated_at = datetime('now')
  WHERE user_id = @userId AND id = @id
`);
const markDeletedStmt = db.prepare("UPDATE trading_agents SET status = 'deleted', updated_at = datetime('now') WHERE user_id = ? AND id = ?");

function upsertAgent(agent) {
  upsertAgentStmt.run({
    userId: agent.userId,
    name: agent.name,
    slug: agent.slug,
    status: agent.status || 'active',
    brainId: agent.brainId,
    personaJson: JSON.stringify(agent.persona || {}),
    biasJson: JSON.stringify(agent.bias || {}),
    sourceUrlsJson: JSON.stringify(agent.sourceUrls || []),
    modelJson: JSON.stringify(agent.model || {}),
  });
  return getBySlug(agent.userId, agent.slug);
}

function listAgents(userId) {
  return listAgentsStmt.all(userId).map(deserializeAgent);
}

function getAgent(userId, id) {
  return deserializeAgent(getAgentStmt.get(userId, id));
}

function getBySlug(userId, slug) {
  return deserializeAgent(getBySlugStmt.get(userId, slug));
}

function updateAgent(userId, id, patch) {
  const existing = getAgent(userId, id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    persona: patch.persona || existing.persona,
    bias: patch.bias || existing.bias,
    sourceUrls: patch.sourceUrls || existing.sourceUrls,
    model: patch.model || existing.model,
    brainId: patch.brainId || patch.brain_id || existing.brain_id,
  };
  updateAgentStmt.run({
    userId,
    id,
    name: next.name,
    status: next.status || 'active',
    brainId: next.brainId,
    personaJson: JSON.stringify(next.persona || {}),
    biasJson: JSON.stringify(next.bias || {}),
    sourceUrlsJson: JSON.stringify(next.sourceUrls || []),
    modelJson: JSON.stringify(next.model || {}),
  });
  return getAgent(userId, id);
}

function markDeleted(userId, id) {
  const existing = getAgent(userId, id);
  if (!existing) return null;
  markDeletedStmt.run(userId, id);
  return getAgent(userId, id);
}

function createCouncilRun({ userId, researchSnapshotId, conversationId, status = 'complete', summary, recommendations }) {
  const tx = db.transaction(() => {
    const { lastInsertRowid } = insertCouncilRunStmt.run({
      userId,
      researchSnapshotId: researchSnapshotId || null,
      conversationId: conversationId || null,
      status,
      summaryJson: JSON.stringify(summary || {}),
    });
    for (const recommendation of recommendations || []) {
      insertRecommendationStmt.run({
        councilRunId: lastInsertRowid,
        agentId: recommendation.agentId,
        symbol: recommendation.symbol,
        action: recommendation.action,
        conviction: recommendation.conviction,
        rationale: recommendation.rationale || null,
        evidenceJson: JSON.stringify(recommendation.evidence || {}),
      });
    }
    return lastInsertRowid;
  });
  return getCouncilRun(tx());
}

function getCouncilRun(id) {
  const row = db.prepare('SELECT * FROM agent_council_runs WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...deserializeRun(row),
    recommendations: recommendationsForRunStmt.all(id).map(deserializeRecommendation),
  };
}

function listCouncilRuns(userId, limit = 20) {
  return listRunsStmt.all(userId, limit).map((row) => ({
    ...deserializeRun(row),
    recommendations: recommendationsForRunStmt.all(row.id).map(deserializeRecommendation),
  }));
}

function deserializeAgent(row) {
  if (!row) return row;
  return {
    ...row,
    persona: JSON.parse(row.persona_json || '{}'),
    bias: JSON.parse(row.bias_json || '{}'),
    sourceUrls: JSON.parse(row.source_urls_json || '[]'),
    model: JSON.parse(row.model_json || '{}'),
  };
}

function deserializeRun(row) {
  return {
    ...row,
    summary: JSON.parse(row.summary_json || '{}'),
  };
}

function deserializeRecommendation(row) {
  return {
    ...row,
    evidence: JSON.parse(row.evidence_json || '{}'),
  };
}

module.exports = {
  upsertAgent,
  listAgents,
  getAgent,
  getBySlug,
  updateAgent,
  markDeleted,
  createCouncilRun,
  getCouncilRun,
  listCouncilRuns,
};
