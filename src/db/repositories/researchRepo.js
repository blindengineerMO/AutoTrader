const db = require('../connection');

const insertSnapshot = db.prepare(`
  INSERT INTO research_snapshots (source, summary_json, signals_json) VALUES (?, ?, ?)
`);
const latest = db.prepare('SELECT * FROM research_snapshots ORDER BY created_at DESC LIMIT ?');
const byId = db.prepare('SELECT * FROM research_snapshots WHERE id = ?');

function create({ source, summary, signals }) {
  const { lastInsertRowid } = insertSnapshot.run(source, JSON.stringify(summary), JSON.stringify(signals));
  return deserialize(byId.get(lastInsertRowid));
}

function getLatest(limit = 1) {
  const rows = latest.all(limit);
  return rows.map(deserialize);
}

function deserialize(row) {
  if (!row) return row;
  return { ...row, summary: JSON.parse(row.summary_json), signals: JSON.parse(row.signals_json) };
}

module.exports = { create, getLatest, getById: (id) => deserialize(byId.get(id)) };
