UPDATE broker_accounts
SET broker = 'alpaca'
WHERE broker = 'robinhood'
  AND NOT EXISTS (
    SELECT 1
    FROM broker_accounts AS existing
    WHERE existing.user_id = broker_accounts.user_id
      AND existing.broker = 'alpaca'
      AND existing.account_label = broker_accounts.account_label
  );
