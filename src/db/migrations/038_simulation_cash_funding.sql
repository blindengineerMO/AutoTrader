CREATE TABLE IF NOT EXISTS simulation_cash_funding_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usd REAL NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('once', 'daily', 'weekly', 'monthly')),
  weekday INTEGER,
  month_day INTEGER,
  time_of_day TEXT NOT NULL DEFAULT '09:00',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  next_run_at TEXT,
  last_run_at TEXT,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS simulation_cash_funding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  funding_rule_id INTEGER REFERENCES simulation_cash_funding_rules(id) ON DELETE SET NULL,
  broker_account_id INTEGER NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  amount_usd REAL NOT NULL,
  balance_after_usd REAL NOT NULL,
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sim_cash_funding_rules_due ON simulation_cash_funding_rules(user_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_sim_cash_funding_events_user_created ON simulation_cash_funding_events(user_id, created_at DESC);
