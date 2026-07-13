UPDATE user_settings
SET watcher_cycle_cadence_cron = '0 * * * *'
WHERE watcher_cycle_cadence_cron = '0 6,10,13,16 * * 1-5';
