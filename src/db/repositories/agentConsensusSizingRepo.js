const db = require('../connection');

const upsertStmt = db.prepare(`
  INSERT INTO agent_consensus_sizing (user_id, symbol, council_run_id, disagreement_factor, mean_conviction, conviction_std_dev, buy_votes, sell_votes, computed_at)
  VALUES (@userId, @symbol, @councilRunId, @disagreementFactor, @meanConviction, @convictionStdDev, @buyVotes, @sellVotes, datetime('now'))
  ON CONFLICT(user_id, symbol) DO UPDATE SET
    council_run_id = excluded.council_run_id,
    disagreement_factor = excluded.disagreement_factor,
    mean_conviction = excluded.mean_conviction,
    conviction_std_dev = excluded.conviction_std_dev,
    buy_votes = excluded.buy_votes,
    sell_votes = excluded.sell_votes,
    computed_at = excluded.computed_at
`);

const getFreshStmt = db.prepare(`
  SELECT * FROM agent_consensus_sizing
  WHERE user_id = ? AND symbol = ? AND computed_at >= datetime('now', ?)
`);

function upsertForSymbol(userId, symbol, { councilRunId, disagreementFactor, meanConviction, convictionStdDev, buyVotes, sellVotes }) {
  upsertStmt.run({ userId, symbol, councilRunId, disagreementFactor, meanConviction, convictionStdDev, buyVotes, sellVotes });
}

function getFreshForSymbol(userId, symbol, { maxAgeHours = 48 } = {}) {
  return getFreshStmt.get(userId, symbol, `-${maxAgeHours} hours`) || null;
}

module.exports = { upsertForSymbol, getFreshForSymbol };
