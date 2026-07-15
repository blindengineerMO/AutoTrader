ALTER TABLE user_settings ADD COLUMN alpaca_statement_download_day INTEGER NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS alpaca_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alpaca_account_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  document_type TEXT NOT NULL DEFAULT 'account_statement',
  document_date TEXT,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  download_url TEXT,
  local_path TEXT,
  content_type TEXT,
  file_size_bytes INTEGER,
  downloaded_at TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, alpaca_account_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_alpaca_documents_user_date ON alpaca_documents(user_id, document_date DESC);
CREATE INDEX IF NOT EXISTS idx_alpaca_documents_user_type ON alpaca_documents(user_id, document_type);
