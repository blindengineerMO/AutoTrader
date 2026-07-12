CREATE TABLE IF NOT EXISTS provider_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  secret_json_encrypted TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'configured',
  last_validated_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, provider_key)
);

CREATE TABLE IF NOT EXISTS decision_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trading_plan_id INTEGER REFERENCES trading_plans(id) ON DELETE SET NULL,
  research_snapshot_id INTEGER REFERENCES research_snapshots(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'simulation')),
  live_ready INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE trading_plans ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_provider_credentials_user ON provider_credentials (user_id);
CREATE INDEX IF NOT EXISTS idx_decision_reports_user ON decision_reports (user_id, created_at);
