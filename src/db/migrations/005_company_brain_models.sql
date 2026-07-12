CREATE TABLE IF NOT EXISTS brain_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  model_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, model_key)
);

CREATE TABLE IF NOT EXISTS company_intelligence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  company_name TEXT,
  summary_json TEXT NOT NULL,
  last_researched_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_company_intelligence_user ON company_intelligence (user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_brain_models_user_key ON brain_models (user_id, model_key);
