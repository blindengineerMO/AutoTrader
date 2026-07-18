ALTER TABLE user_settings ADD COLUMN investing_mode TEXT NOT NULL DEFAULT 'balanced' CHECK (investing_mode IN ('aggressive', 'balanced', 'conservative'));
