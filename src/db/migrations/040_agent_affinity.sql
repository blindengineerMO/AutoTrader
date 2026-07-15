CREATE TABLE IF NOT EXISTS agent_affinity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_slug_a TEXT NOT NULL,
  agent_slug_b TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'general',
  interactions INTEGER NOT NULL DEFAULT 0,
  challenges_upheld INTEGER NOT NULL DEFAULT 0,
  challenges_overruled INTEGER NOT NULL DEFAULT 0,
  affinity_score REAL NOT NULL DEFAULT 0,
  last_interaction_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_slug_a, agent_slug_b, topic)
);

CREATE INDEX IF NOT EXISTS idx_agent_affinity_pair ON agent_affinity (agent_slug_a, agent_slug_b);
