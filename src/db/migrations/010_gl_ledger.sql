CREATE TABLE IF NOT EXISTS gl_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_account_id INTEGER REFERENCES broker_accounts(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  plan_action_id INTEGER REFERENCES plan_actions(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  quantity REAL,
  unit_price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source_type TEXT NOT NULL DEFAULT 'order_fill',
  memo TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gl_entries_user_created ON gl_entries (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gl_entries_user_symbol_created ON gl_entries (user_id, symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_gl_entries_order ON gl_entries (order_id);
