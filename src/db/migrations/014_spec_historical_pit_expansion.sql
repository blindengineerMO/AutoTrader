CREATE TABLE IF NOT EXISTS corporate_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('split', 'cash_dividend', 'special_dividend', 'symbol_change', 'merger', 'delisting')),
  ex_date TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  ratio REAL,
  cash_amount REAL,
  new_symbol TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  source_raw_id INTEGER REFERENCES raw_source_data(id),
  revision_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, symbol, action_type, ex_date, revision_version)
);

CREATE TABLE IF NOT EXISTS market_calendar_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  session_date TEXT NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1,
  open_at TEXT,
  close_at TEXT,
  early_close INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  source_raw_id INTEGER REFERENCES raw_source_data(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market, session_date)
);

CREATE TABLE IF NOT EXISTS universe_memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  universe_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  permanent_id TEXT NOT NULL,
  member_from TEXT,
  member_to TEXT,
  reason TEXT,
  source_raw_id INTEGER REFERENCES raw_source_data(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, universe_version, symbol, permanent_id)
);

CREATE INDEX IF NOT EXISTS idx_corporate_actions_user_symbol ON corporate_actions (user_id, symbol, ex_date);
CREATE INDEX IF NOT EXISTS idx_market_calendar_day ON market_calendar_days (market, session_date);
CREATE INDEX IF NOT EXISTS idx_universe_memberships_user_version ON universe_memberships (user_id, universe_version, symbol);
