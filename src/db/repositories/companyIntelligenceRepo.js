const db = require('../connection');

const upsertStmt = db.prepare(`
  INSERT INTO company_intelligence (user_id, symbol, company_name, summary_json, last_researched_at)
  VALUES (@userId, @symbol, @companyName, @summaryJson, datetime('now'))
  ON CONFLICT(user_id, symbol) DO UPDATE SET
    company_name = excluded.company_name,
    summary_json = excluded.summary_json,
    last_researched_at = datetime('now'),
    updated_at = datetime('now')
`);
const listStmt = db.prepare('SELECT * FROM company_intelligence WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?');
const bySymbolStmt = db.prepare('SELECT * FROM company_intelligence WHERE user_id = ? AND symbol = ?');

function save({ userId, symbol, companyName, summary }) {
  upsertStmt.run({
    userId,
    symbol,
    companyName: companyName || symbol,
    summaryJson: JSON.stringify(summary || {}),
  });
  return getBySymbol(userId, symbol);
}

function deserialize(row) {
  if (!row) return row;
  return { ...row, summary: JSON.parse(row.summary_json || '{}') };
}

function getBySymbol(userId, symbol) {
  return deserialize(bySymbolStmt.get(userId, symbol));
}

module.exports = {
  save,
  getBySymbol,
  listByUser: (userId, limit = 100) => listStmt.all(userId, limit).map(deserialize),
};
