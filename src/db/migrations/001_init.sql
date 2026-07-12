CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS broker_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker TEXT NOT NULL DEFAULT 'robinhood',
  account_label TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'not_connected',
  cash_balance_usd REAL NOT NULL DEFAULT 0,
  buying_power_usd REAL NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, broker, account_label)
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kill_switch_engaged INTEGER NOT NULL DEFAULT 0,
  daily_loss_limit_usd REAL NOT NULL DEFAULT 10,
  max_trades_per_symbol_per_24h INTEGER NOT NULL DEFAULT 3,
  research_cadence_cron TEXT NOT NULL DEFAULT '0 8,12 * * 1-5',
  trading_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kill_switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  engaged INTEGER NOT NULL,
  triggered_by TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS research_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  signals_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trading_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  research_snapshot_id INTEGER NOT NULL REFERENCES research_snapshots(id),
  model_used TEXT NOT NULL,
  raw_response_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_plan_id INTEGER NOT NULL REFERENCES trading_plans(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'hold')),
  quantity REAL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  plan_action_id INTEGER REFERENCES plan_actions(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'market',
  status TEXT NOT NULL DEFAULT 'submitted',
  broker_order_id TEXT,
  fill_price REAL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  filled_at TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  avg_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (broker_account_id, symbol)
);

CREATE TABLE IF NOT EXISTS pnl_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id),
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  balance_after_usd REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_user_symbol_submitted ON orders (user_id, symbol, submitted_at);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions (user_id);
CREATE INDEX IF NOT EXISTS idx_pnl_user ON pnl_ledger (user_id);
CREATE INDEX IF NOT EXISTS idx_trading_plans_user ON trading_plans (user_id);
