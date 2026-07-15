ALTER TABLE user_settings ADD COLUMN day_trading_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE user_settings SET research_cadence_cron = '0 * * * *' WHERE research_cadence_cron = '0 8,12 * * 1-5';
