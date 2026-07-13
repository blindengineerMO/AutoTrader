const db = require('../connection');

const insertRun = db.prepare(`
  INSERT INTO forecast_runs (user_id, symbol, horizon_days, series_json)
  VALUES (@userId, @symbol, @horizonDays, @seriesJson)
`);

const latestByUserSymbol = db.prepare(`
  SELECT * FROM forecast_runs
  WHERE user_id = ? AND symbol = ?
  ORDER BY generated_at DESC
  LIMIT 1
`);

function deserialize(row) {
  if (!row) return row;
  return { ...row, series: JSON.parse(row.series_json || '[]') };
}

function save({ userId, symbol, horizonDays, series }) {
  const { lastInsertRowid } = insertRun.run({
    userId,
    symbol,
    horizonDays,
    seriesJson: JSON.stringify(series),
  });
  return deserialize(db.prepare('SELECT * FROM forecast_runs WHERE id = ?').get(lastInsertRowid));
}

function getLatest(userId, symbol) {
  return deserialize(latestByUserSymbol.get(userId, symbol));
}

module.exports = { save, getLatest };
