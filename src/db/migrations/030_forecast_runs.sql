CREATE TABLE IF NOT EXISTS forecast_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  horizon_days INTEGER NOT NULL,
  series_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_forecast_runs_user_symbol ON forecast_runs(user_id, symbol);
