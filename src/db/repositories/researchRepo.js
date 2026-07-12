const db = require('../connection');

const insertSnapshot = db.prepare(`
  INSERT INTO research_snapshots (user_id, source, summary_json, signals_json) VALUES (?, ?, ?, ?)
`);
const latest = db.prepare('SELECT * FROM research_snapshots ORDER BY created_at DESC LIMIT ?');
const latestByUser = db.prepare('SELECT * FROM research_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
const byId = db.prepare('SELECT * FROM research_snapshots WHERE id = ?');
const byIdForUser = db.prepare('SELECT * FROM research_snapshots WHERE id = ? AND user_id = ?');

function create({ userId, source, summary, signals }) {
  const { lastInsertRowid } = insertSnapshot.run(userId || null, source, JSON.stringify(summary), JSON.stringify(signals));
  return deserialize(byId.get(lastInsertRowid));
}

function getLatest(limit = 1) {
  const rows = latest.all(limit);
  return rows.map(deserialize);
}

function listByUser(userId, limit = 5) {
  return latestByUser.all(userId, limit).map(deserialize);
}

function deserialize(row) {
  if (!row) return row;
  return { ...row, summary: JSON.parse(row.summary_json), signals: JSON.parse(row.signals_json) };
}

module.exports = {
  create,
  getLatest,
  listByUser,
  getById: (id) => deserialize(byId.get(id)),
  getByIdForUser: (id, userId) => deserialize(byIdForUser.get(id, userId)),
};
