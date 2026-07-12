CREATE TABLE IF NOT EXISTS model_training_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  artifact_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS model_rollback_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rollback_id TEXT NOT NULL,
  from_model_version TEXT NOT NULL,
  to_model_version TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, rollback_id)
);

CREATE INDEX IF NOT EXISTS idx_model_training_snapshots_user ON model_training_snapshots (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_rollback_events_user ON model_rollback_events (user_id, created_at);
