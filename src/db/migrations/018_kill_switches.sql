ALTER TABLE user_settings ADD COLUMN model_drift_kill_switch_engaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN model_drift_kill_switch_reason TEXT;
ALTER TABLE user_settings ADD COLUMN model_drift_kill_switch_at TEXT;

ALTER TABLE user_settings ADD COLUMN broker_connection_kill_switch_engaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN broker_connection_kill_switch_reason TEXT;
ALTER TABLE user_settings ADD COLUMN broker_connection_kill_switch_at TEXT;

ALTER TABLE user_settings ADD COLUMN market_data_kill_switch_engaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN market_data_kill_switch_reason TEXT;
ALTER TABLE user_settings ADD COLUMN market_data_kill_switch_at TEXT;

ALTER TABLE user_settings ADD COLUMN reconciliation_failure_kill_switch_engaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN reconciliation_failure_kill_switch_reason TEXT;
ALTER TABLE user_settings ADD COLUMN reconciliation_failure_kill_switch_at TEXT;

ALTER TABLE user_settings ADD COLUMN automatic_strategy_kill_switch_engaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_settings ADD COLUMN automatic_strategy_kill_switch_reason TEXT;
ALTER TABLE user_settings ADD COLUMN automatic_strategy_kill_switch_at TEXT;
