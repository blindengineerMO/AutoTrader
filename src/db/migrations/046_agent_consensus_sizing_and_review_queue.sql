CREATE TABLE IF NOT EXISTS agent_consensus_sizing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  council_run_id INTEGER NOT NULL REFERENCES agent_council_runs(id) ON DELETE CASCADE,
  disagreement_factor REAL NOT NULL,
  mean_conviction REAL,
  conviction_std_dev REAL,
  buy_votes INTEGER,
  sell_votes INTEGER,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_agent_consensus_sizing_user ON agent_consensus_sizing(user_id, symbol);

CREATE TABLE IF NOT EXISTS agent_review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  council_run_id INTEGER NOT NULL REFERENCES agent_council_runs(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('high_disagreement', 'split_vote', 'low_confidence')),
  mean_conviction REAL,
  conviction_std_dev REAL,
  disagreement_factor REAL,
  buy_votes INTEGER,
  sell_votes INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  reviewed_at TEXT,
  reviewed_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(council_run_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_agent_review_queue_user_status ON agent_review_queue(user_id, status, created_at);

ALTER TABLE user_settings ADD COLUMN council_sizing_enabled INTEGER NOT NULL DEFAULT 0;
