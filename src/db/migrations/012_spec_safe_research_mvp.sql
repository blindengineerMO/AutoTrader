CREATE TABLE IF NOT EXISTS securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  permanent_id TEXT NOT NULL,
  exchange TEXT NOT NULL DEFAULT 'UNKNOWN',
  security_type TEXT NOT NULL DEFAULT 'common_stock',
  listing_date TEXT,
  delisting_date TEXT,
  sector TEXT,
  industry TEXT,
  market_cap_usd REAL,
  shares_outstanding REAL,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_tradeable INTEGER NOT NULL DEFAULT 1,
  exclusion_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, symbol, permanent_id)
);

CREATE TABLE IF NOT EXISTS raw_source_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  observed_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  revision_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  UNIQUE (user_id, source_name, content_hash, revision_version)
);

CREATE TABLE IF NOT EXISTS pit_market_bars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  security_id INTEGER REFERENCES securities(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  bar_date TEXT NOT NULL,
  open_unadjusted REAL,
  high_unadjusted REAL,
  low_unadjusted REAL,
  close_unadjusted REAL,
  close_adjusted REAL,
  volume REAL,
  bid REAL,
  ask REAL,
  data_source TEXT NOT NULL,
  source_raw_id INTEGER REFERENCES raw_source_data(id),
  as_of TEXT NOT NULL,
  available_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  revision_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (user_id, symbol, bar_date, data_source, revision_version)
);

CREATE TABLE IF NOT EXISTS data_quality_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dataset_version TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail')),
  critical INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feature_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dataset_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'blocked')) DEFAULT 'created',
  quality_report_id INTEGER REFERENCES data_quality_reports(id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, dataset_version, feature_version)
);

CREATE TABLE IF NOT EXISTS feature_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_set_id INTEGER NOT NULL REFERENCES feature_sets(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  as_of TEXT NOT NULL,
  available_at TEXT NOT NULL,
  features_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (feature_set_id, symbol)
);

CREATE TABLE IF NOT EXISTS model_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_version TEXT NOT NULL,
  model_type TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'approved', 'champion', 'rejected', 'retired')),
  approved_by TEXT,
  approved_at TEXT,
  promotion_report_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, model_version)
);

CREATE TABLE IF NOT EXISTS portfolio_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  dataset_version TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  market_regime TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, run_id)
);

CREATE TABLE IF NOT EXISTS risk_check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  symbol TEXT,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'warn', 'fail')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spec_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paper_order_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL,
  limit_price REAL,
  notional_usd REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'risk_rejected', 'simulated', 'cancelled')) DEFAULT 'planned',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  risk_result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, client_order_id)
);

CREATE INDEX IF NOT EXISTS idx_securities_user_symbol ON securities (user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_raw_source_user_source ON raw_source_data (user_id, source_name, observed_at);
CREATE INDEX IF NOT EXISTS idx_pit_market_user_symbol_date ON pit_market_bars (user_id, symbol, bar_date);
CREATE INDEX IF NOT EXISTS idx_quality_user_dataset ON data_quality_reports (user_id, dataset_version);
CREATE INDEX IF NOT EXISTS idx_feature_rows_symbol ON feature_rows (symbol, as_of);
CREATE INDEX IF NOT EXISTS idx_model_registry_user_status ON model_registry (user_id, status);
CREATE INDEX IF NOT EXISTS idx_risk_run ON risk_check_results (user_id, run_id);
CREATE INDEX IF NOT EXISTS idx_spec_audit_run ON spec_audit_events (user_id, run_id);
