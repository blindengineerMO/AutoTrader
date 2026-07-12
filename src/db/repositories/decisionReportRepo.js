const db = require('../connection');

const insertStmt = db.prepare(`
  INSERT INTO decision_reports (
    user_id, trading_plan_id, research_snapshot_id, mode, live_ready, summary_json
  )
  VALUES (@userId, @tradingPlanId, @researchSnapshotId, @mode, @liveReady, @summaryJson)
`);
const getByIdStmt = db.prepare('SELECT * FROM decision_reports WHERE id = ?');
const listByUserStmt = db.prepare('SELECT * FROM decision_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');

function create({ userId, tradingPlanId, researchSnapshotId, mode, liveReady, summary }) {
  const { lastInsertRowid } = insertStmt.run({
    userId,
    tradingPlanId: tradingPlanId || null,
    researchSnapshotId: researchSnapshotId || null,
    mode,
    liveReady: liveReady ? 1 : 0,
    summaryJson: JSON.stringify(summary),
  });
  return getById(lastInsertRowid);
}

function deserialize(row) {
  if (!row) return null;
  return { ...row, liveReady: Boolean(row.live_ready), summary: JSON.parse(row.summary_json) };
}

function getById(id) {
  return deserialize(getByIdStmt.get(id));
}

function listByUser(userId, limit = 20) {
  return listByUserStmt.all(userId, limit).map(deserialize);
}

module.exports = { create, getById, listByUser };
