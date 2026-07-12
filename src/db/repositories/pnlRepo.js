const db = require('../connection');

const insertEntry = db.prepare(`
  INSERT INTO pnl_ledger (user_id, broker_account_id, order_id, realized_pnl_usd, balance_after_usd, note)
  VALUES (@userId, @brokerAccountId, @orderId, @realizedPnlUsd, @balanceAfterUsd, @note)
`);
const listByUser = db.prepare('SELECT * FROM pnl_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT ?');
const sumSince = db.prepare(`
  SELECT COALESCE(SUM(realized_pnl_usd), 0) AS total FROM pnl_ledger
  WHERE user_id = ? AND created_at >= ?
`);

module.exports = {
  record: (entry) => insertEntry.run(entry),
  listByUser: (userId, limit = 100) => listByUser.all(userId, limit),
  sumSince: (userId, isoTimestamp) => sumSince.get(userId, isoTimestamp).total,
};
