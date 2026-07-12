CREATE TABLE IF NOT EXISTS model_promotion_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenger_model_version TEXT NOT NULL,
  champion_model_version TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('pending_approval', 'approved', 'rejected')),
  gate_results_json TEXT NOT NULL DEFAULT '[]',
  backtest_run_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, challenger_model_version)
);

CREATE INDEX IF NOT EXISTS idx_model_promotion_reviews_user ON model_promotion_reviews (user_id, created_at);
