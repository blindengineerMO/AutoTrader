const db = require('../connection');

const upsertAgentStmt = db.prepare(`
  INSERT INTO watcher_agents (user_id, symbol, company_name, brain_id, price_tier, status, last_researched_at)
  VALUES (@userId, @symbol, @companyName, @brainId, @priceTier, @status, @lastResearchedAt)
  ON CONFLICT(user_id, symbol) DO UPDATE SET
    company_name = COALESCE(excluded.company_name, watcher_agents.company_name),
    brain_id = excluded.brain_id,
    price_tier = excluded.price_tier,
    status = excluded.status,
    updated_at = datetime('now')
`);

const getByIdStmt = db.prepare('SELECT * FROM watcher_agents WHERE user_id = ? AND id = ?');
const getBySymbolStmt = db.prepare('SELECT * FROM watcher_agents WHERE user_id = ? AND symbol = ?');
const listActiveByUserStmt = db.prepare("SELECT * FROM watcher_agents WHERE user_id = ? AND status = 'active' ORDER BY price_tier ASC, symbol ASC");

const touchResearchedStmt = db.prepare("UPDATE watcher_agents SET last_researched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?");

const insertResearchRunStmt = db.prepare(`
  INSERT INTO watcher_agent_research_runs (
    watcher_agent_id, user_id, symbol, price_at_research, predicted_action, local_ai_score, rationale_json
  )
  VALUES (@watcherAgentId, @userId, @symbol, @priceAtResearch, @predictedAction, @localAiScore, @rationaleJson)
`);

const getResearchRunStmt = db.prepare('SELECT * FROM watcher_agent_research_runs WHERE id = ?');
const listResearchRunsStmt = db.prepare('SELECT * FROM watcher_agent_research_runs WHERE watcher_agent_id = ? ORDER BY run_at DESC LIMIT ?');
const listUngradedRunsForUserStmt = db.prepare(`
  SELECT * FROM watcher_agent_research_runs
  WHERE user_id = ? AND graded = 0 AND date(run_at) = date(?)
  ORDER BY run_at ASC
`);
const markGradedStmt = db.prepare('UPDATE watcher_agent_research_runs SET graded = 1 WHERE id = ?');

const insertGradeStmt = db.prepare(`
  INSERT INTO watcher_agent_grades (
    watcher_agent_id, research_run_id, user_id, symbol, predicted_action, start_price, close_price, return_pct, verdict, rationale
  )
  VALUES (@watcherAgentId, @researchRunId, @userId, @symbol, @predictedAction, @startPrice, @closePrice, @returnPct, @verdict, @rationale)
`);

const listGradesStmt = db.prepare('SELECT * FROM watcher_agent_grades WHERE watcher_agent_id = ? ORDER BY graded_at DESC LIMIT ?');
const scorecardStmt = db.prepare(`
  SELECT
    COUNT(*) AS totalGraded,
    SUM(CASE WHEN verdict = 'praise' THEN 1 ELSE 0 END) AS praiseCount,
    SUM(CASE WHEN verdict = 'punish' THEN 1 ELSE 0 END) AS punishCount
  FROM watcher_agent_grades
  WHERE watcher_agent_id = ?
`);

function upsertAgent(agent) {
  upsertAgentStmt.run({
    userId: agent.userId,
    symbol: agent.symbol,
    companyName: agent.companyName || null,
    brainId: agent.brainId,
    priceTier: agent.priceTier || 'standard',
    status: agent.status || 'active',
    lastResearchedAt: agent.lastResearchedAt || null,
  });
  return getBySymbol(agent.userId, agent.symbol);
}

function getById(userId, id) {
  return getByIdStmt.get(userId, id) || null;
}

function getBySymbol(userId, symbol) {
  return getBySymbolStmt.get(userId, symbol) || null;
}

function listActiveByUser(userId) {
  return listActiveByUserStmt.all(userId);
}

function touchResearched(watcherAgentId) {
  touchResearchedStmt.run(watcherAgentId);
}

function recordResearchRun(run) {
  const { lastInsertRowid } = insertResearchRunStmt.run({
    watcherAgentId: run.watcherAgentId,
    userId: run.userId,
    symbol: run.symbol,
    priceAtResearch: run.priceAtResearch,
    predictedAction: run.predictedAction,
    localAiScore: run.localAiScore,
    rationaleJson: JSON.stringify(run.rationale || {}),
  });
  touchResearched(run.watcherAgentId);
  return deserializeRun(getResearchRunStmt.get(lastInsertRowid));
}

function listResearchRuns(watcherAgentId, limit = 20) {
  return listResearchRunsStmt.all(watcherAgentId, limit).map(deserializeRun);
}

function listUngradedRunsForUser(userId, tradingDay) {
  return listUngradedRunsForUserStmt.all(userId, tradingDay).map(deserializeRun);
}

function markGraded(researchRunId) {
  markGradedStmt.run(researchRunId);
}

function recordGrade(grade) {
  const tx = db.transaction(() => {
    const { lastInsertRowid } = insertGradeStmt.run({
      watcherAgentId: grade.watcherAgentId,
      researchRunId: grade.researchRunId,
      userId: grade.userId,
      symbol: grade.symbol,
      predictedAction: grade.predictedAction,
      startPrice: grade.startPrice,
      closePrice: grade.closePrice,
      returnPct: grade.returnPct,
      verdict: grade.verdict,
      rationale: grade.rationale || null,
    });
    markGradedStmt.run(grade.researchRunId);
    return lastInsertRowid;
  });
  const id = tx();
  return db.prepare('SELECT * FROM watcher_agent_grades WHERE id = ?').get(id);
}

function listGrades(watcherAgentId, limit = 20) {
  return listGradesStmt.all(watcherAgentId, limit);
}

function getScorecard(watcherAgentId) {
  const row = scorecardStmt.get(watcherAgentId);
  const totalGraded = row?.totalGraded || 0;
  const praiseCount = row?.praiseCount || 0;
  const punishCount = row?.punishCount || 0;
  return {
    totalGraded,
    praiseCount,
    punishCount,
    ratio: totalGraded > 0 ? praiseCount / totalGraded : null,
  };
}

const MAX_PEER_SIGNALS = 5;
const getRawByIdStmt = db.prepare('SELECT peer_signal_json FROM watcher_agents WHERE id = ?');
const updatePeerSignalsStmt = db.prepare("UPDATE watcher_agents SET peer_signal_json = ?, updated_at = datetime('now') WHERE id = ?");

function recordPeerSignal(watcherAgentId, signal) {
  const row = getRawByIdStmt.get(watcherAgentId);
  if (!row) return [];
  const existing = JSON.parse(row.peer_signal_json || '[]');
  const updated = [...existing, { ...signal, receivedAt: new Date().toISOString() }].slice(-MAX_PEER_SIGNALS);
  updatePeerSignalsStmt.run(JSON.stringify(updated), watcherAgentId);
  return updated;
}

function listPeerSignals(watcherAgentId) {
  const row = getRawByIdStmt.get(watcherAgentId);
  if (!row) return [];
  return JSON.parse(row.peer_signal_json || '[]');
}

function deserializeRun(row) {
  if (!row) return null;
  return {
    ...row,
    rationale: JSON.parse(row.rationale_json || '{}'),
  };
}

module.exports = {
  upsertAgent,
  getById,
  getBySymbol,
  listActiveByUser,
  touchResearched,
  recordResearchRun,
  listResearchRuns,
  listUngradedRunsForUser,
  markGraded,
  recordGrade,
  listGrades,
  getScorecard,
  recordPeerSignal,
  listPeerSignals,
};
