ALTER TABLE user_settings ADD COLUMN daily_loss_limit_kill_switch_engaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN daily_loss_limit_kill_switch_reason TEXT;
ALTER TABLE user_settings ADD COLUMN daily_loss_limit_kill_switch_at TEXT;
