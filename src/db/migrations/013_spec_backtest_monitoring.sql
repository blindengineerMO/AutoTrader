CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  source_run_id TEXT,
  dataset_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  random_seed INTEGER NOT NULL DEFAULT 0,
  dependency_lock_hash TEXT,
  git_commit TEXT,
  status TEXT NOT NULL CHECK (status IN ('created', 'completed', 'failed')),
  metrics_json TEXT NOT NULL DEFAULT '{}',
  assumptions_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, run_id)
);

CREATE TABLE IF NOT EXISTS backtest_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backtest_run_id TEXT NOT NULL,
  event_ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  symbol TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monitoring_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'fail')),
  details_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, status_key)
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_user ON backtest_runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_backtest_events_run ON backtest_events (user_id, backtest_run_id, event_ts);
CREATE INDEX IF NOT EXISTS idx_monitoring_status_user ON monitoring_status (user_id, status_key);
