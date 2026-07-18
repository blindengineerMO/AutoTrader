CREATE TABLE IF NOT EXISTS agent_recommendation_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  council_run_id INTEGER NOT NULL REFERENCES agent_council_runs(id) ON DELETE CASCADE,
  recommendation_id INTEGER NOT NULL REFERENCES agent_recommendations(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES trading_agents(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  conviction REAL NOT NULL,
  sector_symbol TEXT NOT NULL DEFAULT 'SPY',
  baseline_price REAL,
  recommended_at TEXT NOT NULL DEFAULT (datetime('now')),
  return_1d REAL,
  return_5d REAL,
  return_21d REAL,
  return_63d REAL,
  sector_return_1d REAL,
  sector_return_5d REAL,
  sector_return_21d REAL,
  sector_return_63d REAL,
  correct_1d INTEGER,
  correct_5d INTEGER,
  correct_21d INTEGER,
  correct_63d INTEGER,
  outcome_backfilled_at TEXT,
  UNIQUE(recommendation_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_rec_outcomes_pending ON agent_recommendation_outcomes(user_id, outcome_backfilled_at);
CREATE INDEX IF NOT EXISTS idx_agent_rec_outcomes_agent ON agent_recommendation_outcomes(agent_id);

CREATE TABLE IF NOT EXISTS agent_calibration_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES trading_agents(id) ON DELETE CASCADE,
  horizon TEXT NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  mean_conviction REAL,
  brier_score REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, agent_id, horizon)
);

CREATE TABLE IF NOT EXISTS agent_calibration_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES trading_agents(id) ON DELETE CASCADE,
  horizon TEXT NOT NULL,
  bucket_low INTEGER NOT NULL,
  bucket_high INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  hit_rate REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, agent_id, horizon, bucket_low)
);
