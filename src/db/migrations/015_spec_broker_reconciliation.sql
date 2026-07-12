CREATE TABLE IF NOT EXISTS paper_broker_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT,
  client_order_id TEXT NOT NULL,
  broker_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL,
  requested_price REAL,
  fill_price REAL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'filled', 'rejected', 'cancelled')),
  reason TEXT,
  submitted_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (user_id, client_order_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'fail')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, run_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_differences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reconciliation_run_id TEXT NOT NULL,
  symbol TEXT,
  difference_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  expected_json TEXT NOT NULL DEFAULT '{}',
  actual_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_broker_orders_user_run ON paper_broker_orders (user_id, run_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_user ON reconciliation_runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reconciliation_differences_run ON reconciliation_differences (user_id, reconciliation_run_id);
