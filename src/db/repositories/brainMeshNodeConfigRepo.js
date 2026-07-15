const crypto = require('crypto');
const db = require('../connection');

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const upsertConfigStmt = db.prepare(`
  INSERT INTO brain_mesh_node_config (id, node_id, user_id, key, value_json)
  VALUES (@id, @nodeId, @userId, @key, @valueJson)
  ON CONFLICT(node_id, key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = datetime('now')
`);

const deleteConfigStmt = db.prepare(`
  DELETE FROM brain_mesh_node_config WHERE node_id = ? AND user_id = ? AND key = ?
`);

const listConfigForNodeStmt = db.prepare(`
  SELECT key, value_json FROM brain_mesh_node_config WHERE node_id = ?
`);

function setConfigValue({ nodeId, userId, key, value }) {
  upsertConfigStmt.run({
    id: id('nc'),
    nodeId,
    userId,
    key,
    valueJson: JSON.stringify(value),
  });
  return getConfigForNode(nodeId);
}

function deleteConfigValue({ nodeId, userId, key }) {
  return deleteConfigStmt.run(nodeId, userId, key).changes > 0;
}

function getConfigForNode(nodeId) {
  const rows = listConfigForNodeStmt.all(nodeId);
  const config = {};
  for (const row of rows) {
    config[row.key] = JSON.parse(row.value_json);
  }
  return config;
}

module.exports = {
  setConfigValue,
  deleteConfigValue,
  getConfigForNode,
};
