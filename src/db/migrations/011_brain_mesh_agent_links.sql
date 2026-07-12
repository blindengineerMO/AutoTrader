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
