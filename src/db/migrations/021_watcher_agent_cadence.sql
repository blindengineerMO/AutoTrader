ALTER TABLE user_settings ADD COLUMN watcher_cycle_cadence_cron TEXT NOT NULL DEFAULT '0 6,10,13,16 * * 1-5';
ALTER TABLE user_settings ADD COLUMN watcher_grading_cadence_cron TEXT NOT NULL DEFAULT '30 16 * * 1-5';
