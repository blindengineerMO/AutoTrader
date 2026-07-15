ALTER TABLE user_settings ADD COLUMN fractional_trading_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN fractional_min_notional_usd REAL NOT NULL DEFAULT 1;
ALTER TABLE user_settings ADD COLUMN max_buy_order_notional_usd REAL NOT NULL DEFAULT 100;
