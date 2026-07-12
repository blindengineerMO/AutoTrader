ALTER TABLE user_settings ADD COLUMN evaluation_cadence_cron TEXT NOT NULL DEFAULT '0 0 * * *';
ALTER TABLE user_settings ADD COLUMN source_learning_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS research_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  source_type TEXT NOT NULL DEFAULT 'learned',
  status TEXT NOT NULL DEFAULT 'active',
  discovery_method TEXT NOT NULL DEFAULT 'manual',
  discovered_from_url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  relevance_score REAL NOT NULL DEFAULT 50,
  credibility_score REAL NOT NULL DEFAULT 50,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_scraped_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, url)
);

CREATE TABLE IF NOT EXISTS research_source_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES research_sources(id) ON DELETE SET NULL,
  research_run_id INTEGER REFERENCES research_runs(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT,
  links_json TEXT NOT NULL DEFAULT '[]',
  score_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evaluation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_research_sources_user_score ON research_sources (user_id, status, relevance_score, credibility_score);
CREATE INDEX IF NOT EXISTS idx_source_observations_user ON research_source_observations (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_reports_user ON evaluation_reports (user_id, report_date);
