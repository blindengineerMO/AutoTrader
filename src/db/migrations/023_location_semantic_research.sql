CREATE TABLE IF NOT EXISTS company_location_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  company_name TEXT,
  profile_json TEXT NOT NULL DEFAULT '{}',
  last_researched_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, symbol)
);

CREATE TABLE IF NOT EXISTS research_memory_vectors (
  observation_id INTEGER PRIMARY KEY REFERENCES research_source_observations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES research_sources(id) ON DELETE SET NULL,
  vector_json TEXT NOT NULL,
  terms_json TEXT NOT NULL DEFAULT '[]',
  text_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS research_observation_fts
USING fts5(title, excerpt, url, tokenize = 'porter');

CREATE INDEX IF NOT EXISTS idx_location_profiles_user_symbol ON company_location_profiles (user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_research_memory_vectors_user ON research_memory_vectors (user_id, created_at);
