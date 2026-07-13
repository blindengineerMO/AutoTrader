ALTER TABLE user_settings ADD COLUMN personality_tick_cadence_cron TEXT NOT NULL DEFAULT '0 * * * *';
