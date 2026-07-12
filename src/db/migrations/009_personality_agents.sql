CREATE TABLE IF NOT EXISTS trading_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  brain_id TEXT NOT NULL,
  persona_json TEXT NOT NULL DEFAULT '{}',
  bias_json TEXT NOT NULL DEFAULT '{}',
  source_urls_json TEXT NOT NULL DEFAULT '[]',
  model_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS agent_council_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  research_snapshot_id INTEGER REFERENCES research_snapshots(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES brain_mesh_conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  council_run_id INTEGER NOT NULL REFERENCES agent_council_runs(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES trading_agents(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'hold', 'watch')),
  conviction REAL NOT NULL DEFAULT 0,
  rationale TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trading_agents_user_status ON trading_agents (user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_council_runs_user_created ON agent_council_runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_recommendations_run_symbol ON agent_recommendations (council_run_id, symbol);
