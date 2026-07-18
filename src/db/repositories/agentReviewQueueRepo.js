const db = require('../connection');

const createStmt = db.prepare(`
  INSERT INTO agent_review_queue (user_id, council_run_id, symbol, reason, mean_conviction, conviction_std_dev, disagreement_factor, buy_votes, sell_votes)
  VALUES (@userId, @councilRunId, @symbol, @reason, @meanConviction, @convictionStdDev, @disagreementFactor, @buyVotes, @sellVotes)
  ON CONFLICT(council_run_id, symbol) DO NOTHING
`);

const listByUserStmt = db.prepare('SELECT * FROM agent_review_queue WHERE user_id = ? AND status = ? ORDER BY created_at DESC');
const listAllByUserStmt = db.prepare('SELECT * FROM agent_review_queue WHERE user_id = ? ORDER BY created_at DESC');

const updateStatusStmt = db.prepare(`
  UPDATE agent_review_queue
  SET status = @status, reviewed_note = @note, reviewed_at = datetime('now')
  WHERE id = @id AND user_id = @userId
`);
const getByIdStmt = db.prepare('SELECT * FROM agent_review_queue WHERE id = ? AND user_id = ?');

function create(userId, councilRunId, symbol, reason, { meanConviction, convictionStdDev, disagreementFactor, buyVotes, sellVotes }) {
  createStmt.run({ userId, councilRunId, symbol, reason, meanConviction, convictionStdDev, disagreementFactor, buyVotes, sellVotes });
}

function listByUser(userId, { status } = {}) {
  return status ? listByUserStmt.all(userId, status) : listAllByUserStmt.all(userId);
}

function updateStatus(id, userId, status, note = null) {
  updateStatusStmt.run({ id, userId, status, note });
  return getByIdStmt.get(id, userId);
}

module.exports = { create, listByUser, updateStatus };
