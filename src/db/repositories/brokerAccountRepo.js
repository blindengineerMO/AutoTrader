const db = require('../connection');

const insertStmt = db.prepare(`
  INSERT INTO broker_accounts (user_id, broker, account_label, status)
  VALUES (@userId, @broker, @accountLabel, @status)
`);
const findByUser = db.prepare('SELECT * FROM broker_accounts WHERE user_id = ?');
const findDefault = db.prepare(
  "SELECT * FROM broker_accounts WHERE user_id = ? AND account_label = 'default' LIMIT 1"
);
const findDefaultByBroker = db.prepare(
  "SELECT * FROM broker_accounts WHERE user_id = ? AND broker = ? AND account_label = 'default' LIMIT 1"
);
const updateBalance = db.prepare(`
  UPDATE broker_accounts
  SET cash_balance_usd = ?, buying_power_usd = ?, status = ?, last_synced_at = datetime('now')
  WHERE id = ?
`);

function ensureDefault(userId, broker = 'robinhood') {
  const existing = findDefaultByBroker.get(userId, broker);
  if (existing) return existing;
  const { lastInsertRowid } = insertStmt.run({
    userId,
    broker,
    accountLabel: 'default',
    status: 'not_connected',
  });
  return findDefaultByBroker.get(userId, broker) || db.prepare('SELECT * FROM broker_accounts WHERE id = ?').get(lastInsertRowid);
}

module.exports = {
  ensureDefault,
  listForUser: (userId) => findByUser.all(userId),
  getDefault: (userId, broker = null) => broker ? findDefaultByBroker.get(userId, broker) : findDefault.get(userId),
  updateBalance: (id, cash, buyingPower, status) => updateBalance.run(cash, buyingPower, status, id),
};
