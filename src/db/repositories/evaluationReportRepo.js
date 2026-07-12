const db = require('../connection');

const insertStmt = db.prepare(`
  INSERT INTO evaluation_reports (user_id, report_date, status, period_start, period_end, summary_json)
  VALUES (@userId, @reportDate, @status, @periodStart, @periodEnd, @summaryJson)
`);

const byIdStmt = db.prepare('SELECT * FROM evaluation_reports WHERE id = ?');
const listByUserStmt = db.prepare('SELECT * FROM evaluation_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');

function create({ userId, reportDate, status = 'complete', periodStart, periodEnd, summary }) {
  const { lastInsertRowid } = insertStmt.run({
    userId,
    reportDate,
    status,
    periodStart,
    periodEnd,
    summaryJson: JSON.stringify(summary),
  });
  return getById(lastInsertRowid);
}

function deserialize(row) {
  if (!row) return row;
  return { ...row, summary: JSON.parse(row.summary_json || '{}') };
}

function getById(id) {
  return deserialize(byIdStmt.get(id));
}

module.exports = {
  create,
  getById,
  listByUser: (userId, limit = 30) => listByUserStmt.all(userId, limit).map(deserialize),
};
