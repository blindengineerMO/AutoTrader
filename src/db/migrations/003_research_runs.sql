CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  terminal_json TEXT NOT NULL DEFAULT '[]',
  research_snapshot_id INTEGER REFERENCES research_snapshots(id) ON DELETE SET NULL,
  trading_plan_id INTEGER REFERENCES trading_plans(id) ON DELETE SET NULL,
  decision_report_id INTEGER REFERENCES decision_reports(id) ON DELETE SET NULL,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_runs_user_started ON research_runs (user_id, started_at);
