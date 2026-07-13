ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN updated_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

UPDATE users
SET updated_at = COALESCE(updated_at, created_at, datetime('now')),
    password_changed_at = COALESCE(password_changed_at, created_at, datetime('now'));

UPDATE users
SET role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

CREATE INDEX IF NOT EXISTS idx_users_role_status ON users (role, status);
