const db = require('../connection');

let upsertStmt;
let bySymbolStmt;
let listStmt;

function save({ userId, symbol, companyName, profile }) {
  getUpsertStmt().run({
    userId,
    symbol,
    companyName: companyName || symbol,
    profileJson: JSON.stringify(profile || {}),
  });
  return getBySymbol(userId, symbol);
}

function getBySymbol(userId, symbol) {
  try {
    return deserialize(getBySymbolStmt().get(userId, symbol));
  } catch {
    return null;
  }
}

function deserialize(row) {
  if (!row) return row;
  return { ...row, profile: JSON.parse(row.profile_json || '{}') };
}

module.exports = {
  save,
  getBySymbol,
  listByUser: (userId, limit = 100) => {
    try {
      return getListStmt().all(userId, limit).map(deserialize);
    } catch {
      return [];
    }
  },
};

function getUpsertStmt() {
  if (!upsertStmt) {
    upsertStmt = db.prepare(`
      INSERT INTO company_location_profiles (user_id, symbol, company_name, profile_json, last_researched_at)
      VALUES (@userId, @symbol, @companyName, @profileJson, datetime('now'))
      ON CONFLICT(user_id, symbol) DO UPDATE SET
        company_name = excluded.company_name,
        profile_json = excluded.profile_json,
        last_researched_at = datetime('now'),
        updated_at = datetime('now')
    `);
  }
  return upsertStmt;
}

function getBySymbolStmt() {
  if (!bySymbolStmt) bySymbolStmt = db.prepare('SELECT * FROM company_location_profiles WHERE user_id = ? AND symbol = ?');
  return bySymbolStmt;
}

function getListStmt() {
  if (!listStmt) listStmt = db.prepare('SELECT * FROM company_location_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?');
  return listStmt;
}
