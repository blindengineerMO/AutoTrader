const db = require('../connection');

const insertOutcomeStmt = db.prepare(`
  INSERT OR IGNORE INTO agent_recommendation_outcomes (
    user_id, council_run_id, recommendation_id, agent_id, symbol, action,
    conviction, sector_symbol, baseline_price
  ) VALUES (
    @userId, @councilRunId, @recommendationId, @agentId, @symbol, @action,
    @conviction, @sectorSymbol, @baselinePrice
  )
`);

const awaitingReturnsStmt = db.prepare(`
  SELECT * FROM agent_recommendation_outcomes
  WHERE user_id = ?
    AND (return_1d IS NULL OR return_5d IS NULL OR return_21d IS NULL OR return_63d IS NULL)
    AND recommended_at <= datetime('now', ?)
  ORDER BY recommended_at ASC
  LIMIT ?
`);

const VALID_HORIZONS = new Set(['1d', '5d', '21d', '63d']);

function listLabeledByHorizon(userId, horizonKey) {
  if (!VALID_HORIZONS.has(horizonKey)) throw new Error(`Unknown horizon: ${horizonKey}`);
  return db.prepare(`
    SELECT agent_id, conviction, correct_${horizonKey} AS correct
    FROM agent_recommendation_outcomes
    WHERE user_id = ? AND correct_${horizonKey} IS NOT NULL
  `).all(userId);
}

// `recommendations` is the deserialized `agent_recommendations` row array returned by
// tradingAgentRepo.createCouncilRun/getCouncilRun (snake_case columns + parsed `evidence`).
function createForRecommendations(userId, councilRunId, recommendations, { resolveSectorSymbol } = {}) {
  let inserted = 0;
  for (const rec of recommendations || []) {
    if (!rec.id || !rec.agent_id || !rec.symbol) continue;
    const signal = rec.evidence?.signal || {};
    const sectorSymbol = (resolveSectorSymbol && resolveSectorSymbol(signal.theme)) || 'SPY';
    const result = insertOutcomeStmt.run({
      userId,
      councilRunId,
      recommendationId: rec.id,
      agentId: rec.agent_id,
      symbol: rec.symbol,
      action: rec.action,
      conviction: Number(rec.conviction || 0),
      sectorSymbol,
      baselinePrice: Number.isFinite(Number(signal.price)) ? Number(signal.price) : null,
    });
    inserted += result.changes;
  }
  return inserted;
}

function listAwaitingReturns(userId, { minAgeCalendarDays = 1, limit = 50 } = {}) {
  return awaitingReturnsStmt.all(userId, `-${minAgeCalendarDays} days`, limit);
}

const UPDATABLE_FIELDS = [
  'return_1d', 'return_5d', 'return_21d', 'return_63d',
  'sector_return_1d', 'sector_return_5d', 'sector_return_21d', 'sector_return_63d',
  'correct_1d', 'correct_5d', 'correct_21d', 'correct_63d',
];

function updateOutcomes(id, fields) {
  const sets = UPDATABLE_FIELDS.filter((column) => fields[column] !== undefined);
  if (!sets.length) return;
  const sql = `UPDATE agent_recommendation_outcomes
    SET ${sets.map((column) => `${column} = @${column}`).join(', ')}, outcome_backfilled_at = datetime('now')
    WHERE id = @id`;
  db.prepare(sql).run({ id, ...fields });
}

module.exports = {
  createForRecommendations,
  listAwaitingReturns,
  updateOutcomes,
  listLabeledByHorizon,
};
