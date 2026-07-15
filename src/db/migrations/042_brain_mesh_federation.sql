CREATE TABLE IF NOT EXISTS brain_mesh_join_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  consumed_by_node_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_brain_mesh_join_tokens_user ON brain_mesh_join_tokens (user_id);

CREATE TABLE IF NOT EXISTS brain_mesh_nodes (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  client_version TEXT,
  last_seen_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brain_mesh_nodes_user ON brain_mesh_nodes (user_id);

CREATE TABLE IF NOT EXISTS brain_mesh_node_capabilities (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES brain_mesh_nodes(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  current_load INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(node_id, op)
);

CREATE INDEX IF NOT EXISTS idx_brain_mesh_node_capabilities_op ON brain_mesh_node_capabilities (op);

CREATE TABLE IF NOT EXISTS brain_mesh_node_jobs (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES brain_mesh_nodes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned',
  request_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_brain_mesh_node_jobs_node_status ON brain_mesh_node_jobs (node_id, status);
