CREATE TABLE IF NOT EXISTS event_training_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  event_category TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_direction TEXT NOT NULL,
  base_weight REAL NOT NULL DEFAULT 0,
  certainty TEXT,
  source_type TEXT,
  source_reliability REAL,
  source_domain TEXT,
  statement_text TEXT,
  affected_metric TEXT,
  market_expectation TEXT,
  surprise_direction TEXT,
  final_event_score REAL NOT NULL DEFAULT 0,
  evidence_url TEXT,
  document_id TEXT NOT NULL DEFAULT '',
  sector_symbol TEXT NOT NULL DEFAULT 'SPY',
  event_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  baseline_close REAL,
  stock_return_1_day REAL,
  stock_return_21_days REAL,
  sector_return_21_days REAL,
  sector_adjusted_return_21_days REAL,
  fundamental_result_2_quarters_later TEXT,
  original_model_prediction_correct INTEGER,
  outcome_backfilled_at TEXT,
  UNIQUE(user_id, symbol, event_type, document_id)
);

CREATE INDEX IF NOT EXISTS idx_event_training_labels_outcomes
  ON event_training_labels(user_id, outcome_backfilled_at);

CREATE TABLE IF NOT EXISTS event_category_learning (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1.0,
  samples INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, category)
);
