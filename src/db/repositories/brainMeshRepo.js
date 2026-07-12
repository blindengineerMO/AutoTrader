const db = require('../connection');

db.exec(`
  CREATE TABLE IF NOT EXISTS brain_mesh_agent_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES brain_mesh_agents(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, agent_id, board_id)
  );
  CREATE INDEX IF NOT EXISTS idx_brain_mesh_agent_links_user_board ON brain_mesh_agent_links (user_id, board_id);
`);

const upsertAgentStmt = db.prepare(`
  INSERT INTO brain_mesh_agents (id, user_id, role, capabilities_json, status, last_seen_at, metadata_json)
  VALUES (@id, @userId, @role, @capabilitiesJson, @status, datetime('now'), @metadataJson)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    role = excluded.role,
    capabilities_json = excluded.capabilities_json,
    status = excluded.status,
    last_seen_at = datetime('now'),
    metadata_json = excluded.metadata_json
`);

const listAgentsStmt = db.prepare(`
  SELECT * FROM brain_mesh_agents
  WHERE user_id IS NULL OR user_id = ?
  ORDER BY role, id
`);
const removeAgentStmt = db.prepare(`
  UPDATE brain_mesh_agents
  SET status = 'removed', last_seen_at = datetime('now')
  WHERE id = ? AND user_id IS ?
`);

const upsertConversationStmt = db.prepare(`
  INSERT INTO brain_mesh_conversations (id, user_id, topic, status, metadata_json)
  VALUES (@id, @userId, @topic, @status, @metadataJson)
  ON CONFLICT(id) DO UPDATE SET
    topic = excluded.topic,
    status = excluded.status,
    updated_at = datetime('now'),
    metadata_json = excluded.metadata_json
`);

const listConversationsStmt = db.prepare(`
  SELECT * FROM brain_mesh_conversations
  WHERE user_id IS ? OR user_id IS NULL
  ORDER BY updated_at DESC
  LIMIT ?
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO brain_mesh_messages (
    id, user_id, conversation_id, trace_id, causation_id, sender, recipient,
    kind, op, status, envelope_json
  )
  VALUES (
    @id, @userId, @conversationId, @traceId, @causationId, @sender, @recipient,
    @kind, @op, @status, @envelopeJson
  )
`);

const listMessagesStmt = db.prepare(`
  SELECT * FROM brain_mesh_messages
  WHERE (@userId IS NULL OR user_id IS @userId OR user_id IS NULL)
    AND (@conversationId IS NULL OR conversation_id = @conversationId)
    AND (@traceId IS NULL OR trace_id = @traceId)
  ORDER BY created_at DESC
  LIMIT @limit
`);
const upsertAgentLinkStmt = db.prepare(`
  INSERT INTO brain_mesh_agent_links (user_id, agent_id, board_id, role, metadata_json)
  VALUES (@userId, @agentId, @boardId, @role, @metadataJson)
  ON CONFLICT(user_id, agent_id, board_id) DO UPDATE SET
    role = excluded.role,
    metadata_json = excluded.metadata_json,
    updated_at = datetime('now')
`);
const deleteAgentLinkStmt = db.prepare(`
  DELETE FROM brain_mesh_agent_links
  WHERE user_id IS ? AND agent_id = ? AND board_id = ?
`);
const listAgentLinksStmt = db.prepare(`
  SELECT l.*, a.role AS agent_role, a.capabilities_json, a.status AS agent_status, a.metadata_json AS agent_metadata_json
  FROM brain_mesh_agent_links l
  JOIN brain_mesh_agents a ON a.id = l.agent_id
  WHERE l.user_id IS @userId AND (@boardId IS NULL OR l.board_id = @boardId)
  ORDER BY l.board_id, l.role, l.agent_id
`);

function upsertAgent(agent) {
  upsertAgentStmt.run({
    id: agent.id,
    userId: agent.userId || null,
    role: agent.role || 'brain',
    capabilitiesJson: JSON.stringify(agent.capabilities || []),
    status: agent.status || 'online',
    metadataJson: JSON.stringify(agent.metadata || {}),
  });
  return agent;
}

function listAgents(userId) {
  return listAgentsStmt.all(userId || null).map(deserializeAgent);
}

function removeAgent(id, userId) {
  removeAgentStmt.run(id, userId || null);
  return true;
}

function upsertConversation(conversation) {
  upsertConversationStmt.run({
    id: conversation.id,
    userId: conversation.userId || null,
    topic: conversation.topic || 'untitled',
    status: conversation.status || 'open',
    metadataJson: JSON.stringify(conversation.metadata || {}),
  });
  return conversation;
}

function listConversations(userId, limit = 50) {
  return listConversationsStmt.all(userId || null, limit).map(deserializeConversation);
}

function recordMessage(envelope, status = 'accepted') {
  insertMessageStmt.run({
    id: envelope.id,
    userId: envelope.ctx?.userId || null,
    conversationId: envelope.conv || null,
    traceId: envelope.trace,
    causationId: envelope.cause || null,
    sender: envelope.from,
    recipient: Array.isArray(envelope.to) ? envelope.to.join(',') : envelope.to,
    kind: envelope.kind,
    op: envelope.op,
    status,
    envelopeJson: JSON.stringify(envelope),
  });
  return envelope;
}

function listMessages({ userId, conversationId = null, traceId = null, limit = 100 } = {}) {
  return listMessagesStmt
    .all({
      userId: userId || null,
      conversationId,
      traceId,
      limit,
    })
    .map(deserializeMessage);
}

function linkAgentToBoard({ userId, agentId, boardId, role = 'member', metadata = {} }) {
  upsertAgentLinkStmt.run({
    userId: userId || null,
    agentId,
    boardId,
    role,
    metadataJson: JSON.stringify(metadata || {}),
  });
  return { userId: userId || null, agentId, boardId, role, metadata };
}

function unlinkAgentFromBoard({ userId, agentId, boardId }) {
  deleteAgentLinkStmt.run(userId || null, agentId, boardId);
  return { ok: true, userId: userId || null, agentId, boardId };
}

function listAgentLinks({ userId, boardId = null } = {}) {
  return listAgentLinksStmt.all({ userId: userId || null, boardId }).map((row) => ({
    id: row.id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    board_id: row.board_id,
    role: row.role,
    metadata: JSON.parse(row.metadata_json || '{}'),
    created_at: row.created_at,
    updated_at: row.updated_at,
    agent: {
      id: row.agent_id,
      role: row.agent_role,
      capabilities: JSON.parse(row.capabilities_json || '[]'),
      status: row.agent_status,
      metadata: JSON.parse(row.agent_metadata_json || '{}'),
    },
  }));
}

function deserializeAgent(row) {
  return {
    ...row,
    capabilities: JSON.parse(row.capabilities_json || '[]'),
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

function deserializeConversation(row) {
  return {
    ...row,
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

function deserializeMessage(row) {
  return {
    ...row,
    envelope: JSON.parse(row.envelope_json || '{}'),
  };
}

module.exports = {
  upsertAgent,
  removeAgent,
  listAgents,
  upsertConversation,
  listConversations,
  recordMessage,
  listMessages,
  linkAgentToBoard,
  unlinkAgentFromBoard,
  listAgentLinks,
};
