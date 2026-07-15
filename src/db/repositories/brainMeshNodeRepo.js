const crypto = require('crypto');
const db = require('../connection');

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const insertJoinTokenStmt = db.prepare(`
  INSERT INTO brain_mesh_join_tokens (id, user_id, token_hash, label, expires_at)
  VALUES (@id, @userId, @tokenHash, @label, @expiresAt)
`);

const findPendingJoinTokenStmt = db.prepare(`
  SELECT * FROM brain_mesh_join_tokens
  WHERE token_hash = ? AND status = 'pending' AND expires_at > datetime('now')
`);

const consumeJoinTokenStmt = db.prepare(`
  UPDATE brain_mesh_join_tokens
  SET status = 'consumed', consumed_by_node_id = @nodeId, consumed_at = datetime('now')
  WHERE token_hash = @tokenHash AND status = 'pending' AND expires_at > datetime('now')
`);

const listJoinTokensStmt = db.prepare(`
  SELECT id, user_id, label, status, expires_at, consumed_by_node_id, created_at, consumed_at
  FROM brain_mesh_join_tokens
  WHERE user_id = ?
  ORDER BY created_at DESC
`);

const revokeJoinTokenStmt = db.prepare(`
  UPDATE brain_mesh_join_tokens
  SET status = 'revoked'
  WHERE id = ? AND user_id = ? AND status = 'pending'
`);

const upsertNodeStmt = db.prepare(`
  INSERT INTO brain_mesh_nodes (id, user_id, public_key, label, status, client_version, last_seen_at, metadata_json)
  VALUES (@id, @userId, @publicKey, @label, @status, @clientVersion, datetime('now'), @metadataJson)
  ON CONFLICT(public_key) DO UPDATE SET
    status = excluded.status,
    client_version = excluded.client_version,
    last_seen_at = datetime('now'),
    metadata_json = excluded.metadata_json,
    updated_at = datetime('now')
`);

const getNodeByPublicKeyStmt = db.prepare(`SELECT * FROM brain_mesh_nodes WHERE public_key = ?`);
const getNodeStmt = db.prepare(`SELECT * FROM brain_mesh_nodes WHERE id = ? AND user_id = ?`);
const listNodesStmt = db.prepare(`SELECT * FROM brain_mesh_nodes WHERE user_id = ? ORDER BY created_at DESC`);

const revokeNodeStmt = db.prepare(`
  UPDATE brain_mesh_nodes SET status = 'revoked', updated_at = datetime('now')
  WHERE id = ? AND user_id = ?
`);

const setNodeStatusStmt = db.prepare(`
  UPDATE brain_mesh_nodes SET status = ?, last_seen_at = datetime('now'), updated_at = datetime('now')
  WHERE id = ?
`);

const upsertCapabilityStmt = db.prepare(`
  INSERT INTO brain_mesh_node_capabilities (id, node_id, op, max_concurrency, updated_at)
  VALUES (@id, @nodeId, @op, @maxConcurrency, datetime('now'))
  ON CONFLICT(node_id, op) DO UPDATE SET
    max_concurrency = excluded.max_concurrency,
    updated_at = datetime('now')
`);

const deleteCapabilitiesForNodeStmt = db.prepare(`DELETE FROM brain_mesh_node_capabilities WHERE node_id = ?`);

const incrementNodeLoadStmt = db.prepare(`
  UPDATE brain_mesh_node_capabilities SET current_load = current_load + 1, updated_at = datetime('now')
  WHERE node_id = ? AND op = ?
`);

const decrementNodeLoadStmt = db.prepare(`
  UPDATE brain_mesh_node_capabilities
  SET current_load = MAX(0, current_load - 1), updated_at = datetime('now')
  WHERE node_id = ? AND op = ?
`);

const listNodesByCapabilityStmt = db.prepare(`
  SELECT n.*, c.max_concurrency, c.current_load, c.updated_at AS capability_updated_at
  FROM brain_mesh_node_capabilities c
  JOIN brain_mesh_nodes n ON n.id = c.node_id
  WHERE c.op = ? AND n.user_id = ? AND n.status = 'online'
`);

const insertNodeJobStmt = db.prepare(`
  INSERT INTO brain_mesh_node_jobs (id, node_id, user_id, op, status, request_json)
  VALUES (@id, @nodeId, @userId, @op, 'assigned', @requestJson)
`);

const recordJobResultStmt = db.prepare(`
  UPDATE brain_mesh_node_jobs
  SET status = @status, result_json = @resultJson, error = @error, completed_at = datetime('now')
  WHERE id = @id
`);

function createJoinToken({ userId, label = null, ttlMs = 15 * 60 * 1000 }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenId = id('jt');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  insertJoinTokenStmt.run({ id: tokenId, userId, tokenHash: hashToken(token), label, expiresAt });
  return { id: tokenId, token, label, expiresAt };
}

const consumeJoinTokenTxn = db.transaction((tokenHash, nodeId) => {
  const row = findPendingJoinTokenStmt.get(tokenHash);
  if (!row) return null;
  consumeJoinTokenStmt.run({ tokenHash, nodeId });
  return row;
});

function consumeJoinToken(token, nodeId) {
  const row = consumeJoinTokenTxn(hashToken(token), nodeId);
  return row ? { userId: row.user_id, tokenId: row.id } : null;
}

function listJoinTokens(userId) {
  return listJoinTokensStmt.all(userId);
}

function revokeJoinToken(tokenId, userId) {
  return revokeJoinTokenStmt.run(tokenId, userId).changes > 0;
}

function upsertNode({ id: nodeId, userId, publicKey, label = null, status = 'online', clientVersion = null, metadata = {} }) {
  upsertNodeStmt.run({
    id: nodeId,
    userId,
    publicKey,
    label,
    status,
    clientVersion,
    metadataJson: JSON.stringify(metadata || {}),
  });
  return getNodeByPublicKey(publicKey);
}

function getNodeByPublicKey(publicKey) {
  return deserializeNode(getNodeByPublicKeyStmt.get(publicKey));
}

function getNode(nodeId, userId) {
  return deserializeNode(getNodeStmt.get(nodeId, userId));
}

function listNodes(userId) {
  return listNodesStmt.all(userId).map(deserializeNode);
}

function revokeNode(nodeId, userId) {
  return revokeNodeStmt.run(nodeId, userId).changes > 0;
}

function setNodeStatus(nodeId, status) {
  return setNodeStatusStmt.run(status, nodeId).changes > 0;
}

function upsertNodeCapabilities(nodeId, capabilities = []) {
  deleteCapabilitiesForNodeStmt.run(nodeId);
  for (const cap of capabilities) {
    upsertCapabilityStmt.run({
      id: id('cap'),
      nodeId,
      op: cap.op,
      maxConcurrency: cap.maxConcurrency || 1,
    });
  }
  return true;
}

function incrementNodeLoad(nodeId, op) {
  return incrementNodeLoadStmt.run(nodeId, op).changes > 0;
}

function decrementNodeLoad(nodeId, op) {
  return decrementNodeLoadStmt.run(nodeId, op).changes > 0;
}

function listNodesByCapability(op, userId) {
  return listNodesByCapabilityStmt.all(op, userId).map((row) => ({
    ...deserializeNode(row),
    op,
    maxConcurrency: row.max_concurrency,
    currentLoad: row.current_load,
    capabilityUpdatedAt: row.capability_updated_at,
  }));
}

function recordJobAssigned({ id: jobId, nodeId, userId, op, request = {} }) {
  insertNodeJobStmt.run({ id: jobId, nodeId, userId, op, requestJson: JSON.stringify(request || {}) });
  return { id: jobId, nodeId, userId, op, status: 'assigned' };
}

function recordJobResult({ id: jobId, status, result = null, error = null }) {
  recordJobResultStmt.run({
    id: jobId,
    status,
    resultJson: result ? JSON.stringify(result) : null,
    error,
  });
  return true;
}

function deserializeNode(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

module.exports = {
  createJoinToken,
  consumeJoinToken,
  listJoinTokens,
  revokeJoinToken,
  upsertNode,
  getNodeByPublicKey,
  getNode,
  listNodes,
  revokeNode,
  setNodeStatus,
  upsertNodeCapabilities,
  incrementNodeLoad,
  decrementNodeLoad,
  listNodesByCapability,
  recordJobAssigned,
  recordJobResult,
};
