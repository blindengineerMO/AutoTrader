CREATE TABLE IF NOT EXISTS brain_mesh_agents (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS brain_mesh_conversations (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS brain_mesh_messages (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES brain_mesh_conversations(id) ON DELETE SET NULL,
  trace_id TEXT NOT NULL,
  causation_id TEXT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brain_mesh_messages_user_created ON brain_mesh_messages (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_brain_mesh_messages_trace ON brain_mesh_messages (trace_id);
CREATE INDEX IF NOT EXISTS idx_brain_mesh_messages_conversation ON brain_mesh_messages (conversation_id, created_at);
