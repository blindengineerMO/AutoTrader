const db = require('../connection');

const upsertStmt = db.prepare(`
  INSERT INTO brain_models (user_id, model_key, model_json, metadata_json)
  VALUES (@userId, @modelKey, @modelJson, @metadataJson)
  ON CONFLICT(user_id, model_key) DO UPDATE SET
    model_json = excluded.model_json,
    metadata_json = excluded.metadata_json,
    updated_at = datetime('now')
`);
const byKeyStmt = db.prepare('SELECT * FROM brain_models WHERE user_id IS ? AND model_key = ?');
const listStmt = db.prepare('SELECT * FROM brain_models WHERE user_id IS ? ORDER BY updated_at DESC');

function save({ userId, modelKey, modelJson, metadata }) {
  upsertStmt.run({
    userId: userId || null,
    modelKey,
    modelJson: JSON.stringify(modelJson),
    metadataJson: JSON.stringify(metadata || {}),
  });
  return get(userId, modelKey);
}

function deserialize(row) {
  if (!row) return row;
  return {
    ...row,
    model: JSON.parse(row.model_json || '{}'),
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

function get(userId, modelKey) {
  return deserialize(byKeyStmt.get(userId || null, modelKey));
}

module.exports = {
  save,
  get,
  list: (userId) => listStmt.all(userId || null).map(deserialize),
};
