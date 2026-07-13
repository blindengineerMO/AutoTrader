CREATE TABLE IF NOT EXISTS watcher_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  company_name TEXT,
  brain_id TEXT NOT NULL,
  price_tier TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'active',
  last_researched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, symbol)
);

CREATE TABLE IF NOT EXISTS watcher_agent_research_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_agent_id INTEGER NOT NULL REFERENCES watcher_agents(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  price_at_research REAL,
  predicted_action TEXT,
  local_ai_score REAL,
  rationale_json TEXT NOT NULL DEFAULT '{}',
  graded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watcher_agent_grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_agent_id INTEGER NOT NULL REFERENCES watcher_agents(id) ON DELETE CASCADE,
  research_run_id INTEGER NOT NULL REFERENCES watcher_agent_research_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  predicted_action TEXT NOT NULL,
  start_price REAL,
  close_price REAL,
  return_pct REAL,
  verdict TEXT NOT NULL,
  rationale TEXT,
  graded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watcher_agents_user ON watcher_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_watcher_agent_research_runs_agent ON watcher_agent_research_runs(watcher_agent_id);
CREATE INDEX IF NOT EXISTS idx_watcher_agent_grades_agent ON watcher_agent_grades(watcher_agent_id);
