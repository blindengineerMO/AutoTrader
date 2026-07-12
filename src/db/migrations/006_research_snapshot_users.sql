ALTER TABLE research_snapshots ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_research_snapshots_user_created ON research_snapshots (user_id, created_at);
