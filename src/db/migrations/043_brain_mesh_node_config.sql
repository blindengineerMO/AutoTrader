CREATE TABLE IF NOT EXISTS brain_mesh_node_config (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES brain_mesh_nodes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(node_id, key)
);

CREATE INDEX IF NOT EXISTS idx_brain_mesh_node_config_node ON brain_mesh_node_config (node_id);
